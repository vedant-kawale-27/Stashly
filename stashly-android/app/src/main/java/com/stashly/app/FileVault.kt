/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

package com.stashly.app

import android.content.Context
import android.os.Build
import android.os.Environment
import android.webkit.MimeTypeMap
import org.json.JSONObject
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

    private val metadataFile: File
        get() = File(context.filesDir, "vault_metadata.json")

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
    fun getCiphertext(path: String): ByteArray? {
        val cleanPath = path.replace('\\', '/').removePrefix("/")
        val root = vaultDir.canonicalFile
        val file = File(root, cleanPath).canonicalFile
        val trashFile = File(trashDir, cleanPath.replace('/', '_')).canonicalFile

        val target = if (file.exists() && file.isFile) file else if (trashFile.exists() && trashFile.isFile) trashFile else null
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
