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
    val encryptedDek: String
)

data class TrashEntry(
    val path: String,
    val name: String,
    val sizeBytes: Long,
    val trashedAt: Long,
    val isDirectory: Boolean,
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

    private companion object {
        const val MASTER_KEY_FINGERPRINT = "__stashly_master_key_fingerprint"
    }

    /** True once the user has granted "All files access" in system settings. */
    fun hasFullStorageAccess(): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && Environment.isExternalStorageManager()

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
    private val excludedTopLevelDirs = setOf("Android", ".stashly_trash", ".trash")

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
        val keys = metadata.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            if (!key.startsWith("__trash_")) continue
            val path = key.removePrefix("__trash_")
            val record = metadata.optJSONObject(key) ?: continue
            val trashName = record.optString("trashPath")
            val trashFile = File(trashDir, trashName)
            result += TrashEntry(
                path = path,
                name = path.substringAfterLast('/').ifEmpty { path },
                sizeBytes = record.optLong("sizeBytes", 0L),
                trashedAt = record.optLong("trashedAt", 0L),
                isDirectory = trashFile.isDirectory,
            )
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

    /** Re-scans the vault, (re)encrypting anything new or changed, and returns
     *  the full current file list to push to the broker as a `file_sync`.
     *
     *  First run over a whole phone's storage can take a while — every file
     *  is read and AES-GCM encrypted once so later fetches are instant reads
     *  from [cacheDir] rather than re-encrypting on demand. */
    @Synchronized
    fun scanAndSync(): List<FileSyncEntry> {
        val root = vaultDir
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

        root.walkTopDown()
            .onEnter { dir -> dir == root || dir.relativeTo(root).path.substringBefore(File.separatorChar) !in excludedTopLevelDirs }
            .forEach { item ->
                if (item == root) return@forEach
                val relPath = "/" + item.relativeTo(root).path.replace(File.separatorChar, '/')
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

        newMetadata.put(MASTER_KEY_FINGERPRINT, masterKeyFingerprint)
        saveMetadata(newMetadata)
        return entries
    }

    /** Ciphertext bytes for a previously-synced or trashed path, encrypted on-demand. */
    /** Validates that a resolved path stays inside the given root. Prevents path traversal. */
    private fun isInsideRoot(resolved: File, root: File): Boolean {
        val rootPath = root.path + File.separator
        return resolved.path.startsWith(rootPath) || resolved.path == root.path
    }

    fun getCiphertext(path: String): ByteArray? {
        val cleanPath = path.replace('\\', '/').removePrefix("/")
        if (cleanPath.split('/').contains("..")) return null
        val root = vaultDir.canonicalFile
        val file = File(root, cleanPath).canonicalFile
        val trashRoot = trashDir.canonicalFile
        val trashFile = File(trashDir, cleanPath.replace('/', '_')).canonicalFile

        // Path containment: resolved path must stay inside vault or trash
        val fileOk = file.exists() && file.isFile && isInsideRoot(file, root)
        val trashOk = trashFile.exists() && trashFile.isFile && isInsideRoot(trashFile, trashRoot)
        val target = if (fileOk) file else if (trashOk) trashFile else null
        if (target == null) return null

        val metadata = loadMetadata()
        val record = metadata.optJSONObject(path) ?: metadata.optJSONObject("__trash_$path") ?: return null
        val wrappedDek = record.optString("wrappedDek").ifEmpty { return null }

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
        val root = vaultDir.canonicalFile
        val file = File(root, cleanPath).canonicalFile
        val trashRoot = trashDir.canonicalFile
        val trashFile = File(trashDir, cleanPath.replace('/', '_')).canonicalFile

        // Path containment: resolved path must stay inside vault or trash
        val fileOk = file.exists() && file.isFile && isInsideRoot(file, root)
        val trashOk = trashFile.exists() && trashFile.isFile && isInsideRoot(trashFile, trashRoot)
        val target = if (fileOk) file else if (trashOk) trashFile else null
        if (target == null) return null

        val metadata = loadMetadata()
        val record = metadata.optJSONObject(path) ?: metadata.optJSONObject("__trash_$path") ?: return null
        val wrappedDek = record.optString("wrappedDek").ifEmpty { return null }

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
        val root = vaultDir.canonicalFile
        val file = File(root, cleanPath).canonicalFile
        val trashRoot = trashDir.canonicalFile
        val trashFile = File(trashDir, cleanPath.replace('/', '_')).canonicalFile

        val fileOk = file.exists() && file.isFile && isInsideRoot(file, root)
        val trashOk = trashFile.exists() && trashFile.isFile && isInsideRoot(trashFile, trashRoot)
        val target = if (fileOk) file else if (trashOk) trashFile else null
        return target?.length() ?: -1L
    }

    /** Decrypts a browser upload locally, then writes the plaintext to shared storage. */
    @Synchronized
    fun writeUploadedFile(path: String, encrypted: ByteArray, encryptedDek: String) {
        val cleanPath = path.replace('\\', '/').removePrefix("/")
        require(cleanPath.isNotBlank() && !cleanPath.split('/').contains("..")) { "Invalid upload path" }
        val plaintext = AesGcm.decrypt(keyManager.unwrapDek(encryptedDek), encrypted)
        val root = vaultDir.canonicalFile
        val target = File(root, cleanPath).canonicalFile
        require(target.path.startsWith(root.path + File.separator) || target.path == root.path) { "Upload path is outside shared storage" }
        target.parentFile?.mkdirs()
        require(target.parentFile?.isDirectory == true) { "Upload destination is unavailable" }
        target.writeBytes(plaintext)

        // Store metadata for the uploaded file
        val metadata = loadMetadata()
        val sizeBytes = target.length()
        val lastMod = target.lastModified()
        val hash = sha256Hex("${path}:${sizeBytes}:${lastMod}".toByteArray())
        val record = JSONObject().apply {
            put("wrappedDek", encryptedDek)
            put("contentHash", hash)
            put("sizeBytes", sizeBytes)
            put("mimeType", guessMimeType(target.name))
            put("sourceLastModified", lastMod)
        }
        metadata.put(path, record)
        saveMetadata(metadata)
    }

    /** Moves a file to the Android storage recycle bin (.stashly_trash). */
    @Synchronized
    fun moveToTrash(path: String): Boolean {
        val cleanPath = path.replace('\\', '/').removePrefix("/")
        require(cleanPath.isNotBlank() && !cleanPath.split('/').contains("..")) { "Invalid path" }
        val root = vaultDir.canonicalFile
        val sourceFile = File(root, cleanPath).canonicalFile
        require(sourceFile.path.startsWith(root.path + File.separator) || sourceFile.path == root.path) { "Path outside storage" }

        val trashTarget = File(trashDir, cleanPath.replace('/', '_'))
        trashTarget.parentFile?.mkdirs()

        var moved = false
        if (sourceFile.exists()) {
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
        } else {
            moved = true
        }

        val metadata = loadMetadata()
        val existingRecord = metadata.optJSONObject(path)
        if (existingRecord != null) {
            existingRecord.put("trashedAt", System.currentTimeMillis())
            existingRecord.put("trashPath", trashTarget.name)
            metadata.put("__trash_$path", existingRecord)
            metadata.remove(path)
            saveMetadata(metadata)
        }
        return moved
    }

    /** Restores a previously trashed file back to its original location on Android. */
    @Synchronized
    fun restoreFromTrash(path: String): Boolean {
        val cleanPath = path.replace('\\', '/').removePrefix("/")
        val root = vaultDir.canonicalFile
        val targetFile = File(root, cleanPath).canonicalFile
        val trashSource = File(trashDir, cleanPath.replace('/', '_'))

        if (!trashSource.exists()) return false

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

        val metadata = loadMetadata()
        val trashRecord = metadata.optJSONObject("__trash_$path")
        if (trashRecord != null) {
            trashRecord.remove("trashedAt")
            trashRecord.remove("trashPath")
            metadata.put(path, trashRecord)
            metadata.remove("__trash_$path")
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
        val root = vaultDir.canonicalFile
        val file = File(root, cleanPath).canonicalFile
        val trashFile = File(trashDir, cleanPath.replace('/', '_'))

        var deleted = true
        if (file.exists()) {
            deleted = if (file.isDirectory) file.deleteRecursively() else file.delete()
        }
        if (trashFile.exists()) {
            deleted = (if (trashFile.isDirectory) trashFile.deleteRecursively() else trashFile.delete()) && deleted
        }

        val metadata = loadMetadata()
        metadata.remove(path)
        metadata.remove("__trash_$path")
        saveMetadata(metadata)
        return deleted
    }

    @Synchronized
    fun createFolder(path: String): Boolean {
        val target = safeTarget(path)
        return target.exists() || target.mkdirs()
    }

    @Synchronized
    fun movePath(source: String, destination: String): Boolean {
        val from = safeTarget(source)
        val to = safeTarget(destination)
        to.parentFile?.mkdirs()
        return from.exists() && from.renameTo(to)
    }

    private fun safeTarget(path: String): File {
        val clean = path.replace('\\', '/').removePrefix("/")
        require(clean.isNotBlank() && !clean.split('/').contains("..")) { "Invalid path" }
        val root = vaultDir.canonicalFile
        val target = File(root, clean).canonicalFile
        require(target.path.startsWith(root.path + File.separator) || target.path == root.path) { "Path outside storage" }
        return target
    }

    private fun guessMimeType(name: String): String? {
        val ext = name.substringAfterLast('.', "")
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)
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
        val root = vaultDir.canonicalFile
        val file = File(root, cleanPath).canonicalFile
        // Path containment: must stay inside vault
        if (!isInsideRoot(file, root)) return null
        if (!file.exists() || !file.isFile) return null

        val metadata = loadMetadata()
        val record = metadata.optJSONObject(path) ?: return null
        val wrappedDek = record.optString("wrappedDek").ifEmpty { return null }
        val contentHash = record.optString("contentHash").ifEmpty { return null }
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
        if (!mime.startsWith("image/") && !mime.startsWith("video/")) return null

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

    private fun loadMetadata(): JSONObject =
        try {
            if (metadataFile.exists()) JSONObject(metadataFile.readText()) else JSONObject()
        } catch (_: Exception) {
            JSONObject()
        }

    private fun saveMetadata(obj: JSONObject) {
        try {
            metadataFile.writeText(obj.toString())
        } catch (_: Exception) {}
    }
}
