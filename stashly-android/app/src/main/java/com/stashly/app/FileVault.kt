/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

package com.stashly.app

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.ThumbnailUtils
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Size
import android.webkit.MimeTypeMap
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.MessageDigest
import java.util.UUID

data class FileSyncEntry(
    val path: String,
    val name: String,
    val sizeBytes: Long,
    val contentHash: String,
    val mimeType: String?,
    val encryptedDek: String,
    val isTrashed: Boolean = false
)

data class TrashEntry(
    val path: String,
    val name: String,
    val sizeBytes: Long,
    val trashedAt: Long,
    val isDirectory: Boolean,
)

private data class ThumbnailWarmCandidate(
    val path: String,
    val mimeType: String,
    val wrappedDek: String,
    val contentHash: String,
)

/**
 * Scans the phone's storage — the whole shared storage root ("Internal
 * storage" as seen in any file manager) once All Files Access is granted,
 * or a single app-private folder as a fallback — encrypts new/changed
 * files, and serves ciphertext back to the broker on request.
 *
 * KNOWN LIMITATION: `path` and `name` are sent to the broker as plain
 * text; only file *contents* are encrypted (see AesGcm/KeyManager). That
 * was a reasonable shortcut when this only covered a handful of test
 * files. At whole-phone scope it means filenames — which can themselves
 * be sensitive (`Aadhaar_card_scan.jpg`, `salary_slip_2024.pdf`) — are
 * readable in the broker's database. Encrypting name/path too needs a
 * stable, non-reversible identifier for the broker to key rows on (e.g. a
 * keyed hash of the real path) since re-encrypting the same path can't
 * produce the same ciphertext twice — build that before pointing this at
 * anything you wouldn't want the broker operator to see the names of.
 */
class FileVault(
    private val context: Context,
    private val keyManager: KeyManager,
    private val storage: SecureStorage? = null
) {

    companion object {
        const val MASTER_KEY_FINGERPRINT = "__stashly_master_key_fingerprint"
        const val THUMBNAIL_WARM_BATCH_LIMIT = 2_000
        const val THUMBNAIL_WARM_DELAY_MS = 150L

        @Volatile
        private var isPrewarming = false

        /**
         * Triggers asynchronous background indexing and thumbnail warmup on a low-priority thread.
         * Safe to call on app launch, permission grant, or foreground resumption.
         */
        fun startBackgroundWarmup(context: Context, storage: SecureStorage? = null) {
            if (isPrewarming) return
            val appContext = context.applicationContext
            Thread {
                if (isPrewarming) return@Thread
                isPrewarming = true
                try {
                    val secStorage = storage ?: SecureStorage(appContext)
                    val keyMgr = KeyManager(secStorage)
                    val vault = FileVault(appContext, keyMgr, secStorage)
                    if (vault.hasFullStorageAccess()) {
                        android.util.Log.d("FileVault", "Starting upfront background scan & thumbnail warmup...")
                        vault.scanAndSync()
                        android.util.Log.d("FileVault", "Upfront background scan & thumbnail warmup completed.")
                    }
                } catch (e: Exception) {
                    android.util.Log.w("FileVault", "Background warmup exception: ${e.message}")
                } finally {
                    isPrewarming = false
                }
            }.apply {
                name = "stashly-upfront-warmup"
                priority = Thread.MIN_PRIORITY
                isDaemon = true
                start()
            }
        }
    }

    @Volatile
    private var thumbnailWarmGeneration = 0

    @Volatile
    private var thumbnailWarmThread: Thread? = null

    /** True once the user has granted "All files access" in system settings. */
    fun hasFullStorageAccess(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Environment.isExternalStorageManager()
        } else {
            androidx.core.content.ContextCompat.checkSelfPermission(
                context,
                android.Manifest.permission.READ_EXTERNAL_STORAGE
            ) == android.content.pm.PackageManager.PERMISSION_GRANTED
        }

    val vaultDir: File
        get() {
            return if (hasFullStorageAccess()) {
                Environment.getExternalStorageDirectory() // whole "Internal storage" root
            } else {
                // Fallback for devices below API 30 or before access is granted:
                File(context.getExternalFilesDir(null), "vault").apply { mkdirs() }
            }
        }

    fun clearVaultCache() {
        try {
            cacheDir.deleteRecursively()
            cacheDir.mkdirs()
            if (metadataFile.exists()) metadataFile.delete()
        } catch (_: Exception) {}
    }

    // Skip other apps' private data and hidden trash/cache
    private val excludedTopLevelDirs = setOf("Android", ".stashly_trash", ".trash", "stashly_thumbs")

    val trashDir: File
        get() = File(vaultDir, ".stashly_trash").apply { mkdirs() }

    private val cacheDir: File
        get() = File(context.filesDir, "encrypted_cache").apply { mkdirs() }

    private val thumbsDir: File
        get() = File(context.cacheDir, "stashly_thumbs").apply { mkdirs() }

    private val metadataFile: File
        get() = File(context.filesDir, "vault_metadata.json")

    @Synchronized
    fun listTrash(): List<TrashEntry> {
        val metadata = loadMetadata()
        val result = mutableListOf<TrashEntry>()
        val trackedTrashFiles = mutableSetOf<String>()
        var metadataModified = false

        val keys = metadata.keys()
        val keysList = mutableListOf<String>()
        while (keys.hasNext()) keysList.add(keys.next())

        for (key in keysList) {
            if (!key.startsWith("__trash_")) continue
            val path = key.removePrefix("__trash_")
            val record = metadata.optJSONObject(key) ?: continue
            val trashName = record.optString("trashPath").ifEmpty { path.replace('/', '_').removePrefix("_") }
            val trashFile = File(trashDir, trashName)
            if (!trashFile.exists()) {
                // Disk file no longer exists; prune orphan metadata record
                metadata.remove(key)
                metadataModified = true
                continue
            }
            trackedTrashFiles.add(trashFile.name)
            val normalizedPath = if (path.startsWith("/")) path else "/$path"
            result += TrashEntry(
                path = normalizedPath,
                name = normalizedPath.substringAfterLast('/').ifEmpty { normalizedPath },
                sizeBytes = if (record.has("sizeBytes") && record.optLong("sizeBytes", 0L) > 0L) record.optLong("sizeBytes") else trashFile.length(),
                trashedAt = if (record.has("trashedAt") && record.optLong("trashedAt", 0L) > 0L) record.optLong("trashedAt") else trashFile.lastModified(),
                isDirectory = trashFile.isDirectory,
            )
        }

        // Also detect any physical files in trashDir missing from metadata
        trashDir.listFiles()?.forEach { file ->
            if (file.name !in trackedTrashFiles && file.name != "." && file.name != "..") {
                val reconstructedPath = "/" + file.name.replace('_', '/')
                val trashedAt = file.lastModified()
                val sizeBytes = file.length()
                val dek = AesGcm.randomKey()
                val record = JSONObject().apply {
                    put("trashPath", file.name)
                    put("sizeBytes", sizeBytes)
                    put("trashedAt", trashedAt)
                    put("mimeType", guessMimeType(file.name))
                    put("wrappedDek", keyManager.wrapDek(dek))
                    put("contentHash", "trash_${file.name}")
                }
                metadata.put("__trash_$reconstructedPath", record)
                metadataModified = true
                result += TrashEntry(
                    path = reconstructedPath,
                    name = reconstructedPath.substringAfterLast('/').ifEmpty { reconstructedPath },
                    sizeBytes = sizeBytes,
                    trashedAt = trashedAt,
                    isDirectory = file.isDirectory
                )
            }
        }

        if (metadataModified) {
            saveMetadata(metadata)
        }
        return result.sortedByDescending { it.trashedAt }
    }

    @Synchronized
    fun purgeExpiredTrash(now: Long = System.currentTimeMillis()): Int {
        val cutoff = now - 30L * 24 * 60 * 60 * 1000
        val expired = listTrash().filter { it.trashedAt in 1..cutoff }
        expired.forEach { permanentDelete(it.path) }
        return expired.size
    }

    private fun getMountedSdCard(): File? {
        if (storage?.sdcardAccessEnabled == false) return null
        return StorageUtils.getMountedSdCardFile(context)
    }

    /** Re-scans the vault, (re)encrypting anything new or changed, and returns
     *  the full current file list to push to the broker as a `file_sync`.
     *
     *  First run over a whole phone's storage can take a while — every file
     *  is read and AES-GCM encrypted once so later fetches are instant reads
     *  from [cacheDir] rather than re-encrypting on demand. */
    @Synchronized
    fun scanAndSync(): List<FileSyncEntry> {
        val internalRoot = vaultDir
        val sdRoot = getMountedSdCard()
        val hasSeparateSdCard = sdRoot != null && sdRoot.exists() && sdRoot.canRead()

        var metadata = loadMetadata()
        val masterKeyFingerprint = sha256Hex(keyManager.getOrCreateMasterKey())
        val keyChanged = metadata.optString(MASTER_KEY_FINGERPRINT) != masterKeyFingerprint
        if (keyChanged) {
            metadata = JSONObject()
        }
        val newMetadata = JSONObject()
        val metadataKeys = metadata.keys()
        while (metadataKeys.hasNext()) {
            val key = metadataKeys.next()
            if (key.startsWith("__trash_")) {
                newMetadata.put(key, metadata.get(key))
            }
        }
        val entries = mutableListOf<FileSyncEntry>()

        fun scanDirectory(root: File, pathPrefix: String, applyInternalRestrictions: Boolean) {
            if (pathPrefix.isNotEmpty()) {
                entries += FileSyncEntry(
                    path = pathPrefix,
                    name = pathPrefix.removePrefix("/"),
                    sizeBytes = 0L,
                    contentHash = "directory",
                    mimeType = "inode/directory",
                    encryptedDek = ""
                )
            }
            root.walkTopDown()
                .onEnter { dir ->
                    if (dir == root) return@onEnter true
                    if (dir.name in excludedTopLevelDirs) return@onEnter false
                    if (applyInternalRestrictions) {
                        val topDir = dir.relativeTo(root).path.substringBefore(File.separatorChar)
                        if (topDir in excludedTopLevelDirs) return@onEnter false
                    }
                    true
                }
                .forEach { item ->
                    if (item == root) return@forEach
                    val relPath = pathPrefix + "/" + item.relativeTo(root).path.replace(File.separatorChar, '/')
                    if (item.isDirectory) {
                        entries += FileSyncEntry(
                            path = relPath,
                            name = item.name,
                            sizeBytes = 0L,
                            contentHash = "directory",
                            mimeType = "inode/directory",
                            encryptedDek = ""
                        )
                    } else if (item.isFile) {
                        try {
                            val lastMod = item.lastModified()
                            val sizeBytes = item.length()
                            val existing = if (!keyChanged) metadata.optJSONObject(relPath) else null
                            val unchanged = existing != null &&
                                    existing.optLong("sourceLastModified") == lastMod &&
                                    existing.optLong("sizeBytes") == sizeBytes

                            val (wrappedDek, contentHash) = if (unchanged && existing != null) {
                                Pair(existing.getString("wrappedDek"), existing.getString("contentHash"))
                            } else {
                                val dek = AesGcm.randomKey()
                                val wrapped = keyManager.wrapDek(dek)
                                val hash = sha256Hex("${relPath}:${sizeBytes}:${lastMod}".toByteArray())
                                Pair(wrapped, hash)
                            }

                            val mime = guessMimeType(item.name)
                            val record = JSONObject().apply {
                                put("wrappedDek", wrappedDek)
                                put("contentHash", contentHash)
                                put("sizeBytes", sizeBytes)
                                put("mimeType", mime)
                                put("sourceLastModified", lastMod)
                            }
                            newMetadata.put(relPath, record)

                            entries += FileSyncEntry(
                                path = relPath,
                                name = item.name,
                                sizeBytes = sizeBytes,
                                contentHash = contentHash,
                                mimeType = mime,
                                encryptedDek = wrappedDek
                            )
                        } catch (t: Throwable) {
                            android.util.Log.w("FileVault", "Failed indexing $relPath: ${t.message}")
                        }
                    }
                }
        }

        if (hasSeparateSdCard && sdRoot != null) {
            scanDirectory(internalRoot, "/Internal Storage", applyInternalRestrictions = true)
            scanDirectory(sdRoot, "/SD Card", applyInternalRestrictions = false)
        } else {
            scanDirectory(internalRoot, "", applyInternalRestrictions = true)
        }

        // Also index trashed items so broker displays them in the Recycle Bin view
        val trashList = listTrash()
        for (t in trashList) {
            val record = newMetadata.optJSONObject("__trash_${t.path}")
                ?: newMetadata.optJSONObject("__trash_${t.path.removePrefix("/")}")
                ?: metadata.optJSONObject("__trash_${t.path}")
                ?: metadata.optJSONObject("__trash_${t.path.removePrefix("/")}")
            val wrappedDek = record?.optString("wrappedDek")?.ifEmpty { null } ?: keyManager.wrapDek(AesGcm.randomKey())
            val contentHash = record?.optString("contentHash")?.ifEmpty { null } ?: "trash_${t.path}"
            val mime = record?.optString("mimeType")?.ifEmpty { null } ?: guessMimeType(t.name)
            entries += FileSyncEntry(
                path = t.path,
                name = t.name,
                sizeBytes = t.sizeBytes,
                contentHash = contentHash,
                mimeType = mime,
                encryptedDek = wrappedDek,
                isTrashed = true
            )
        }

        newMetadata.put(MASTER_KEY_FINGERPRINT, masterKeyFingerprint)
        saveMetadata(newMetadata)
        warmThumbnailCache(entries.filter { !it.isTrashed })
        return entries
    }

    /** Validates that a resolved path stays inside the given root. Prevents path traversal. */
    private fun isInsideRoot(resolved: File, root: File): Boolean {
        val rootPath = root.path + File.separator
        return resolved.path.startsWith(rootPath) || resolved.path == root.path
    }

    fun resolveStorageTarget(path: String): Pair<File, File>? {
        val cleanPath = path.replace('\\', '/').removePrefix("/")
        if (cleanPath.split('/').contains("..")) return null
        val internalRoot = vaultDir.canonicalFile
        val sdRoot = getMountedSdCard()?.canonicalFile

        if (cleanPath.startsWith("Internal Storage/") || cleanPath == "Internal Storage") {
            val rel = cleanPath.removePrefix("Internal Storage/").removePrefix("Internal Storage")
            val file = if (rel.isEmpty()) internalRoot else File(internalRoot, rel).canonicalFile
            if (isInsideRoot(file, internalRoot)) return Pair(file, internalRoot)
        } else if (cleanPath.startsWith("SD Card/") || cleanPath == "SD Card") {
            if (sdRoot != null) {
                val rel = cleanPath.removePrefix("SD Card/").removePrefix("SD Card")
                val file = if (rel.isEmpty()) sdRoot else File(sdRoot, rel).canonicalFile
                if (isInsideRoot(file, sdRoot)) return Pair(file, sdRoot)
            }
        } else {
            val file = File(internalRoot, cleanPath).canonicalFile
            if (isInsideRoot(file, internalRoot)) return Pair(file, internalRoot)
            if (sdRoot != null) {
                val sdFile = File(sdRoot, cleanPath).canonicalFile
                if (isInsideRoot(sdFile, sdRoot)) return Pair(sdFile, sdRoot)
            }
        }
        return null
    }

    private fun findMetadataRecord(metadata: JSONObject, path: String, cleanPath: String): JSONObject? {
        return metadata.optJSONObject(path)
            ?: metadata.optJSONObject("/$cleanPath")
            ?: metadata.optJSONObject(cleanPath)
            ?: metadata.optJSONObject("/Internal Storage/$cleanPath")
            ?: metadata.optJSONObject("Internal Storage/$cleanPath")
            ?: metadata.optJSONObject("/SD Card/$cleanPath")
            ?: metadata.optJSONObject("SD Card/$cleanPath")
            ?: metadata.optJSONObject("__trash_$path")
            ?: metadata.optJSONObject("__trash_/$cleanPath")
            ?: metadata.optJSONObject("__trash_$cleanPath")
    }

    fun getCiphertext(path: String): ByteArray? {
        val cleanPath = path.replace('\\', '/').removePrefix("/")
        if (cleanPath.split('/').contains("..")) return null
        val targetPair = resolveStorageTarget(cleanPath)
        val file = targetPair?.first
        val trashRoot = trashDir.canonicalFile
        val trashFile = File(trashDir, cleanPath.replace('/', '_')).canonicalFile

        // Path containment: resolved path must stay inside vault or trash
        val fileOk = file != null && file.exists() && file.isFile
        val trashOk = trashFile.exists() && trashFile.isFile && isInsideRoot(trashFile, trashRoot)
        val target = if (fileOk) file else if (trashOk) trashFile else null
        if (target == null) return null

        val metadata = loadMetadata()
        val record = findMetadataRecord(metadata, path, cleanPath)
        val wrappedDek = record?.optString("wrappedDek")?.ifEmpty { null } ?: run {
            val dek = AesGcm.randomKey()
            keyManager.wrapDek(dek)
        }

        return try {
            val dek = keyManager.unwrapDek(wrappedDek)
            val rawBytes = target.readBytes()
            AesGcm.encrypt(dek, rawBytes)
        } catch (e: Exception) {
            android.util.Log.e("FileVault", "Failed to encrypt $path on demand", e)
            null
        }
    }

    /**
     * Reads a chunk of a file at the given byte offset, encrypts it independently
     * with its own AES-GCM IV, and returns the encrypted chunk. Each chunk can be
     * decrypted independently by the browser.
     */
    fun getChunkCiphertext(path: String, offset: Long, length: Int): ByteArray? {
        val cleanPath = path.replace('\\', '/').removePrefix("/")
        if (cleanPath.split('/').contains("..")) return null
        val targetPair = resolveStorageTarget(cleanPath)
        val file = targetPair?.first
        val trashRoot = trashDir.canonicalFile
        val trashFile = File(trashDir, cleanPath.replace('/', '_')).canonicalFile

        // Path containment: resolved path must stay inside vault or trash
        val fileOk = file != null && file.exists() && file.isFile
        val trashOk = trashFile.exists() && trashFile.isFile && isInsideRoot(trashFile, trashRoot)
        val target = if (fileOk) file else if (trashOk) trashFile else null
        if (target == null) return null

        val metadata = loadMetadata()
        val record = findMetadataRecord(metadata, path, cleanPath)
        val wrappedDek = record?.optString("wrappedDek")?.ifEmpty { null } ?: run {
            val dek = AesGcm.randomKey()
            keyManager.wrapDek(dek)
        }

        return try {
            val dek = keyManager.unwrapDek(wrappedDek)
            val raf = java.io.RandomAccessFile(target, "r")
            val fileSize = raf.length()
            val actualOffset = offset.coerceAtMost(fileSize)
            val actualLength = length.toLong().coerceAtMost(fileSize - actualOffset).toInt()
            if (actualLength <= 0) {
                raf.close()
                return null
            }
            val buffer = ByteArray(actualLength)
            raf.seek(actualOffset)
            raf.readFully(buffer)
            raf.close()
            AesGcm.encrypt(dek, buffer)
        } catch (e: Exception) {
            android.util.Log.e("FileVault", "Failed to read chunk at $path offset=$offset", e)
            null
        }
    }

    /** Returns the raw (plaintext) file size in bytes for chunk calculation. */
    fun getFileSize(path: String): Long {
        val cleanPath = path.replace('\\', '/').removePrefix("/")
        if (cleanPath.split('/').contains("..")) return -1L
        val targetPair = resolveStorageTarget(cleanPath)
        val file = targetPair?.first
        val trashRoot = trashDir.canonicalFile
        val trashFile = File(trashDir, cleanPath.replace('/', '_')).canonicalFile

        val fileOk = file != null && file.exists() && file.isFile
        val trashOk = trashFile.exists() && trashFile.isFile && isInsideRoot(trashFile, trashRoot)
        val target = if (fileOk) file else if (trashOk) trashFile else null
        return target?.length() ?: -1L
    }

    /** Decrypts a browser upload locally, then writes the plaintext to shared storage. */
    @Synchronized
    fun writeUploadedFile(path: String, encrypted: ByteArray, encryptedDek: String): FileSyncEntry {
        val cleanPath = path.replace('\\', '/').removePrefix("/")
        require(cleanPath.isNotBlank() && !cleanPath.split('/').contains("..")) { "Invalid upload path" }
        val targetPair = resolveStorageTarget(cleanPath) ?: run {
            val internalRoot = vaultDir.canonicalFile
            val sdRoot = getMountedSdCard()?.canonicalFile
            if (cleanPath.startsWith("SD Card/") && sdRoot != null) {
                val rel = cleanPath.removePrefix("SD Card/").removePrefix("SD Card")
                val file = File(sdRoot, rel).canonicalFile
                require(isInsideRoot(file, sdRoot)) { "Upload path is outside SD Card" }
                Pair(file, sdRoot)
            } else {
                val rel = cleanPath.removePrefix("Internal Storage/").removePrefix("Internal Storage")
                val file = File(internalRoot, rel).canonicalFile
                require(isInsideRoot(file, internalRoot)) { "Upload path is outside internal storage" }
                Pair(file, internalRoot)
            }
        }
        val target = targetPair.first
        target.parentFile?.mkdirs()
        require(target.parentFile?.isDirectory == true) { "Upload destination is unavailable" }
        val plaintext = AesGcm.decrypt(keyManager.unwrapDek(encryptedDek), encrypted)
        target.writeBytes(plaintext)

        // Store metadata for the uploaded file
        val metadata = loadMetadata()
        val sizeBytes = target.length()
        val lastMod = target.lastModified()
        val hash = sha256Hex("${path}:${sizeBytes}:${lastMod}".toByteArray())
        val mime = guessMimeType(target.name)
        val record = JSONObject().apply {
            put("wrappedDek", encryptedDek)
            put("contentHash", hash)
            put("sizeBytes", sizeBytes)
            put("mimeType", mime)
            put("sourceLastModified", lastMod)
        }
        metadata.put(path, record)
        saveMetadata(metadata)
        val entry = FileSyncEntry(
            path = path,
            name = target.name,
            sizeBytes = sizeBytes,
            contentHash = hash,
            mimeType = mime,
            encryptedDek = encryptedDek
        )
        warmThumbnailCache(listOf(entry))
        return entry
    }

    /** Assembles independently authenticated browser chunks directly to disk. */
    @Synchronized
    fun writeUploadedChunks(path: String, encryptedChunks: List<ByteArray>, encryptedDek: String, totalBytes: Long): FileSyncEntry {
        val cleanPath = path.replace('\\', '/').removePrefix("/")
        require(cleanPath.isNotBlank() && !cleanPath.split('/').contains("..")) { "Invalid upload path" }
        val targetPair = resolveStorageTarget(cleanPath) ?: run {
            val internalRoot = vaultDir.canonicalFile
            val sdRoot = getMountedSdCard()?.canonicalFile
            if (cleanPath.startsWith("SD Card/") && sdRoot != null) {
                val file = File(sdRoot, cleanPath.removePrefix("SD Card/")).canonicalFile
                require(isInsideRoot(file, sdRoot)) { "Upload path is outside SD Card" }
                Pair(file, sdRoot)
            } else {
                val file = File(internalRoot, cleanPath.removePrefix("Internal Storage/")).canonicalFile
                require(isInsideRoot(file, internalRoot)) { "Upload path is outside storage" }
                Pair(file, internalRoot)
            }
        }
        val target = targetPair.first
        target.parentFile?.mkdirs()
        require(target.parentFile?.isDirectory == true) { "Upload destination is unavailable" }
        val dek = keyManager.unwrapDek(encryptedDek)
        val temp = File(target.parentFile, ".${target.name}.stashly-upload-${UUID.randomUUID()}")
        try {
            temp.outputStream().use { out ->
                var written = 0L
                encryptedChunks.forEach { encrypted ->
                    val plain = AesGcm.decrypt(dek, encrypted)
                    out.write(plain)
                    written += plain.size
                }
                require(written == totalBytes) { "Uploaded size does not match manifest" }
            }
            require(temp.renameTo(target)) { "Unable to finalize uploaded file" }
        } finally {
            if (temp.exists()) temp.delete()
        }
        val metadata = loadMetadata()
        val sizeBytes = target.length()
        val lastMod = target.lastModified()
        val hash = sha256Hex("${path}:${sizeBytes}:${lastMod}".toByteArray())
        val mime = guessMimeType(target.name)
        metadata.put(path, JSONObject().apply {
            put("wrappedDek", encryptedDek)
            put("contentHash", hash)
            put("sizeBytes", sizeBytes)
            put("mimeType", mime)
            put("sourceLastModified", lastMod)
        })
        saveMetadata(metadata)
        val entry = FileSyncEntry(
            path = path,
            name = target.name,
            sizeBytes = sizeBytes,
            contentHash = hash,
            mimeType = mime,
            encryptedDek = encryptedDek
        )
        warmThumbnailCache(listOf(entry))
        return entry
    }

    /** Moves a file to the Android storage recycle bin (.stashly_trash). */
    @Synchronized
    fun moveToTrash(path: String): Boolean {
        val cleanPath = path.replace('\\', '/').removePrefix("/")
        require(cleanPath.isNotBlank() && !cleanPath.split('/').contains("..")) { "Invalid path" }
        val targetPair = resolveStorageTarget(cleanPath)
        val sourceFile = targetPair?.first

        val trashTarget = File(trashDir, cleanPath.replace('/', '_'))
        trashTarget.parentFile?.mkdirs()

        var moved = false
        if (sourceFile != null && sourceFile.exists()) {
            moved = sourceFile.renameTo(trashTarget)
            if (!moved) {
                try {
                    if (sourceFile.isDirectory) {
                        sourceFile.copyRecursively(trashTarget, overwrite = true)
                        sourceFile.deleteRecursively()
                    } else {
                        sourceFile.copyTo(trashTarget, overwrite = true)
                        sourceFile.delete()
                    }
                    moved = true
                } catch (e: Exception) {
                    android.util.Log.e("FileVault", "Failed moving to trash: ${e.message}", e)
                    moved = false
                }
            }
        } else if (trashTarget.exists()) {
            moved = true
        } else {
            return false
        }

        if (moved) {
            val metadata = loadMetadata()
            val existingRecord = findMetadataRecord(metadata, path, cleanPath)
            val normalizedPath = if (path.startsWith("/")) path else "/$path"
            val record = existingRecord ?: JSONObject().apply {
                put("sizeBytes", trashTarget.length())
                put("mimeType", guessMimeType(trashTarget.name))
                val dek = AesGcm.randomKey()
                put("wrappedDek", keyManager.wrapDek(dek))
                put("contentHash", "trash_${trashTarget.name}")
            }
            record.put("trashedAt", System.currentTimeMillis())
            record.put("trashPath", trashTarget.name)
            record.put("sizeBytes", trashTarget.length())
            metadata.put("__trash_$normalizedPath", record)
            metadata.remove(normalizedPath)
            metadata.remove(path)
            metadata.remove(cleanPath)
            metadata.remove("/$cleanPath")
            metadata.remove("/Internal Storage/$cleanPath")
            metadata.remove("/SD Card/$cleanPath")
            saveMetadata(metadata)
        }
        return moved
    }

    /** Restores a previously trashed file back to its original location on Android. */
    @Synchronized
    fun restoreFromTrash(path: String): Boolean {
        val cleanPath = path.replace('\\', '/').removePrefix("/")
        val targetPair = resolveStorageTarget(cleanPath) ?: run {
            val internalRoot = vaultDir.canonicalFile
            val sdRoot = getMountedSdCard()?.canonicalFile
            if (cleanPath.startsWith("SD Card/") && sdRoot != null) {
                val rel = cleanPath.removePrefix("SD Card/").removePrefix("SD Card")
                Pair(File(sdRoot, rel).canonicalFile, sdRoot)
            } else {
                val rel = cleanPath.removePrefix("Internal Storage/").removePrefix("Internal Storage")
                Pair(File(internalRoot, rel).canonicalFile, internalRoot)
            }
        }
        val targetFile = targetPair.first
        val trashSource = File(trashDir, cleanPath.replace('/', '_'))

        if (!trashSource.exists()) {
            if (targetFile.exists()) {
                val metadata = loadMetadata()
                val normalizedPath = if (path.startsWith("/")) path else "/$path"
                metadata.remove("__trash_$normalizedPath")
                metadata.remove("__trash_/$cleanPath")
                metadata.remove("__trash_$cleanPath")
                saveMetadata(metadata)
                return true
            }
            return false
        }

        targetFile.parentFile?.mkdirs()
        var restored = trashSource.renameTo(targetFile)
        if (!restored) {
            try {
                if (trashSource.isDirectory) {
                    trashSource.copyRecursively(targetFile, overwrite = true)
                    trashSource.deleteRecursively()
                } else {
                    trashSource.copyTo(targetFile, overwrite = true)
                    trashSource.delete()
                }
                restored = true
            } catch (e: Exception) {
                android.util.Log.e("FileVault", "Failed restoring from trash: ${e.message}", e)
                restored = false
            }
        }

        if (restored) {
            val metadata = loadMetadata()
            val normalizedPath = if (path.startsWith("/")) path else "/$path"
            val trashRecord = findMetadataRecord(metadata, path, cleanPath)
            if (trashRecord != null) {
                trashRecord.remove("trashedAt")
                trashRecord.remove("trashPath")
                trashRecord.put("sourceLastModified", targetFile.lastModified())
                trashRecord.put("sizeBytes", targetFile.length())
                metadata.put(normalizedPath, trashRecord)
            }
            metadata.remove("__trash_$normalizedPath")
            metadata.remove("__trash_/$cleanPath")
            metadata.remove("__trash_$cleanPath")
            saveMetadata(metadata)
        }
        return restored
    }

    /** Permanently removes a file from Android storage and metadata. */
    @Synchronized
    fun deleteFile(path: String, permanent: Boolean = false): Boolean {
        if (!permanent) {
            return moveToTrash(path)
        }
        return permanentDelete(path)
    }

    /** Permanently deletes a file from both active storage and the recycle bin. */
    @Synchronized
    fun permanentDelete(path: String): Boolean {
        val cleanPath = path.replace('\\', '/').removePrefix("/")
        val targetPair = resolveStorageTarget(cleanPath)
        val file = targetPair?.first
        val trashFile = File(trashDir, cleanPath.replace('/', '_'))

        var deleted = true
        if (file != null && file.exists()) {
            deleted = if (file.isDirectory) file.deleteRecursively() else file.delete()
        }
        if (trashFile.exists()) {
            deleted = (if (trashFile.isDirectory) trashFile.deleteRecursively() else trashFile.delete()) && deleted
        }

        val metadata = loadMetadata()
        val normalizedPath = if (path.startsWith("/")) path else "/$path"
        metadata.remove(normalizedPath)
        metadata.remove(path)
        metadata.remove(cleanPath)
        metadata.remove("/$cleanPath")
        metadata.remove("__trash_$normalizedPath")
        metadata.remove("__trash_$path")
        metadata.remove("__trash_/$cleanPath")
        metadata.remove("__trash_$cleanPath")
        saveMetadata(metadata)
        return deleted
    }

    @Synchronized
    fun createFolder(path: String): Boolean {
        val cleanPath = path.replace('\\', '/').removePrefix("/")
        val targetPair = resolveStorageTarget(cleanPath) ?: run {
            val internalRoot = vaultDir.canonicalFile
            val sdRoot = getMountedSdCard()?.canonicalFile
            if (cleanPath.startsWith("SD Card/") && sdRoot != null) {
                val rel = cleanPath.removePrefix("SD Card/").removePrefix("SD Card")
                Pair(File(sdRoot, rel).canonicalFile, sdRoot)
            } else {
                val rel = cleanPath.removePrefix("Internal Storage/").removePrefix("Internal Storage")
                Pair(File(internalRoot, rel).canonicalFile, internalRoot)
            }
        }
        val target = targetPair.first
        return target.exists() || target.mkdirs()
    }

    @Synchronized
    fun movePath(source: String, destination: String): Boolean {
        val fromPair = resolveStorageTarget(source) ?: return false
        val cleanDest = destination.replace('\\', '/').removePrefix("/")
        val toPair = resolveStorageTarget(cleanDest) ?: run {
            val internalRoot = vaultDir.canonicalFile
            val sdRoot = getMountedSdCard()?.canonicalFile
            if (cleanDest.startsWith("SD Card/") && sdRoot != null) {
                val rel = cleanDest.removePrefix("SD Card/").removePrefix("SD Card")
                Pair(File(sdRoot, rel).canonicalFile, sdRoot)
            } else {
                val rel = cleanDest.removePrefix("Internal Storage/").removePrefix("Internal Storage")
                Pair(File(internalRoot, rel).canonicalFile, internalRoot)
            }
        }
        val from = fromPair.first
        val to = toPair.first
        to.parentFile?.mkdirs()
        return from.exists() && from.renameTo(to)
    }

    private fun guessMimeType(name: String): String? {
        val ext = name.substringAfterLast('.', "")
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)
    }

    private fun supportsThumbnail(mimeType: String?): Boolean =
        mimeType?.startsWith("image/") == true || mimeType?.startsWith("video/") == true

    /**
     * Pre-generates encrypted thumbnails in the Android app cache after syncs
     * and uploads. The worker is intentionally slow and restartable: visible
     * thumbnails can still be generated on demand, while this gradually warms
     * nearby/future requests without doing thousands of thumbnails at once.
     */
    private fun warmThumbnailCache(entries: List<FileSyncEntry>) {
        val candidates = entries.asSequence()
            .filter { supportsThumbnail(it.mimeType) && it.contentHash != "directory" && it.encryptedDek.isNotBlank() }
            .filterNot { File(thumbsDir, "${it.contentHash}.enc").exists() }
            .take(THUMBNAIL_WARM_BATCH_LIMIT)
            .map {
                ThumbnailWarmCandidate(
                    path = it.path,
                    mimeType = it.mimeType ?: return@map null,
                    wrappedDek = it.encryptedDek,
                    contentHash = it.contentHash
                )
            }
            .filterNotNull()
            .toList()

        if (candidates.isEmpty()) return

        val generation = thumbnailWarmGeneration + 1
        thumbnailWarmGeneration = generation
        thumbnailWarmThread?.interrupt()
        thumbnailWarmThread = Thread {
            for (candidate in candidates) {
                if (Thread.currentThread().isInterrupted || thumbnailWarmGeneration != generation) return@Thread
                try {
                    val target = resolveStorageTarget(candidate.path)?.first
                    if (target != null && target.exists() && target.isFile) {
                        generateEncryptedThumbnail(target, candidate.mimeType, candidate.wrappedDek, candidate.contentHash)
                    }
                    Thread.sleep(THUMBNAIL_WARM_DELAY_MS)
                } catch (_: InterruptedException) {
                    return@Thread
                } catch (e: Exception) {
                    android.util.Log.d("FileVault", "Thumbnail warmup skipped ${candidate.path}: ${e.message}")
                }
            }
        }.apply {
            name = "stashly-thumbnail-warmup"
            priority = Thread.MIN_PRIORITY
            isDaemon = true
            start()
        }
    }

    /**
     * Public API for on-demand thumbnail generation. Called when the broker
     * relays a thumbnail_request from the web client. Returns the encrypted
     * thumbnail bytes, or null if not supported for this file type.
     * Thumbnails are cached locally to avoid regeneration.
     */
    fun getEncryptedThumbnail(path: String): ByteArray? {
        val cleanPath = path.replace('\\', '/').removePrefix("/")
        if (cleanPath.split('/').contains("..")) return null
        val targetPair = resolveStorageTarget(cleanPath)
        val file = targetPair?.first ?: return null
        if (!file.exists() || !file.isFile) return null

        val metadata = loadMetadata()
        val record = findMetadataRecord(metadata, path, cleanPath)
        val wrappedDek = record?.optString("wrappedDek")?.ifEmpty { null } ?: run {
            val dek = AesGcm.randomKey()
            keyManager.wrapDek(dek)
        }
        val contentHash = record?.optString("contentHash")?.ifEmpty { null } ?: sha256Hex("${cleanPath}:${file.length()}:${file.lastModified()}".toByteArray())
        val mime = guessMimeType(file.name)

        return generateEncryptedThumbnail(file, mime, wrappedDek, contentHash)
    }

    /**
     * Generates an encrypted thumbnail for image/video files.
     * Returns the encrypted thumbnail bytes, or null if the file type
     * doesn't support thumbnails or generation fails.
     * Thumbnails are cached locally to avoid regeneration on every request.
     */
    private fun generateEncryptedThumbnail(
        file: File,
        mimeType: String?,
        wrappedDek: String,
        contentHash: String
    ): ByteArray? {
        val mime = mimeType ?: return null
        if (!supportsThumbnail(mime)) return null

        // Check cached thumbnail first (keyed by contentHash)
        val cachedThumbFile = File(thumbsDir, "$contentHash.enc")
        if (cachedThumbFile.exists()) {
            return try {
                cachedThumbFile.readBytes()
            } catch (_: Exception) { null }
        }

        return try {
            val bitmap: Bitmap? = when {
                mime.startsWith("image/") -> {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        ThumbnailUtils.createImageThumbnail(file, Size(200, 200), null)
                    } else {
                        // Pre-Q fallback: decode with inSampleSize for efficiency
                        val opts = BitmapFactory.Options().apply {
                            inJustDecodeBounds = true
                        }
                        BitmapFactory.decodeFile(file.absolutePath, opts)
                        val scale = maxOf(opts.outWidth / 200, opts.outHeight / 200, 1)
                        val decodeOpts = BitmapFactory.Options().apply {
                            inSampleSize = scale
                        }
                        val raw = BitmapFactory.decodeFile(file.absolutePath, decodeOpts)
                        raw?.let {
                            val w = minOf(it.width, 200)
                            val h = (w.toFloat() / it.width * it.height).toInt().coerceAtLeast(1)
                            Bitmap.createScaledBitmap(it, w, h, true).also { scaled ->
                                if (scaled !== it) it.recycle()
                            }
                        }
                    }
                }
                mime.startsWith("video/") -> {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        ThumbnailUtils.createVideoThumbnail(file, Size(200, 200), null)
                    } else {
                        @Suppress("DEPRECATION")
                        ThumbnailUtils.createVideoThumbnail(
                            file.absolutePath,
                            MediaStore.Images.Thumbnails.MINI_KIND
                        )
                    }
                }
                else -> null
            }

            if (bitmap == null) return null

            // Compress to JPEG
            val baos = ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.JPEG, 70, baos)
            bitmap.recycle()
            val jpegBytes = baos.toByteArray()

            // Encrypt thumbnail with the same DEK as the file
            val dek = keyManager.unwrapDek(wrappedDek)
            val encryptedThumb = AesGcm.encrypt(dek, jpegBytes)

            // Cache to disk
            cachedThumbFile.writeBytes(encryptedThumb)

            encryptedThumb
        } catch (e: Exception) {
            android.util.Log.w("FileVault", "Thumbnail generation failed for ${file.name}: ${e.message}")
            null
        }
    }

    private fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    @Volatile
    private var cachedMetadata: JSONObject? = null

    private fun loadMetadata(): JSONObject {
        cachedMetadata?.let { return it }
        return try {
            val obj = if (metadataFile.exists()) JSONObject(metadataFile.readText()) else JSONObject()
            cachedMetadata = obj
            obj
        } catch (_: Exception) {
            val obj = JSONObject()
            cachedMetadata = obj
            obj
        }
    }

    private fun saveMetadata(obj: JSONObject) {
        cachedMetadata = obj
        try {
            metadataFile.writeText(obj.toString())
        } catch (_: Exception) {}
    }
}
