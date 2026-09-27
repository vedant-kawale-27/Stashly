package com.nimbusnode.app

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
class FileVault(private val context: Context, private val keyManager: KeyManager) {

    /** True once the user has granted "All files access" in system settings. */
    fun hasFullStorageAccess(): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && Environment.isExternalStorageManager()

    private val vaultDir: File
        get() = if (hasFullStorageAccess()) {
            Environment.getExternalStorageDirectory() // whole "Internal storage" root
        } else {
            // Fallback for devices below API 30 or before access is granted:
            // only this app's own private folder is guaranteed accessible
            // without extra permissions.
            File(context.getExternalFilesDir(null), "vault").apply { mkdirs() }
        }

    // Skip other apps' private data (also excluded by the OS on most
    // devices regardless) and anything under our own cache/output paths so
    // we don't recursively re-encrypt our own encrypted cache.
    private val excludedTopLevelDirs = setOf("Android")

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
        val metadata = loadMetadata()
        val entries = mutableListOf<FileSyncEntry>()

        root.walkTopDown()
            .onEnter { dir -> dir == root || dir.relativeTo(root).path.substringBefore(File.separatorChar) !in excludedTopLevelDirs }
            .filter { it.isFile }
            .forEach { file ->
                val relPath = "/" + file.relativeTo(root).path.replace(File.separatorChar, '/')
                val existing = metadata.optJSONObject(relPath)
                val unchanged = existing != null && existing.optLong("sourceLastModified") == file.lastModified()

                val record = if (unchanged) {
                    existing!!
                } else {
                    reEncrypt(file, relPath).also { metadata.put(relPath, it) }
                }

                entries += FileSyncEntry(
                    path = relPath,
                    name = file.name,
                    sizeBytes = record.getLong("sizeBytes"),
                    contentHash = record.getString("contentHash"),
                    mimeType = record.optString("mimeType", null),
                    encryptedDek = record.getString("wrappedDek")
                )
            }

        saveMetadata(metadata)
        return entries
    }

    /** Ciphertext bytes for a previously-synced path, or null if unknown/missing. */
    fun getCiphertext(path: String): ByteArray? {
        val record = loadMetadata().optJSONObject(path) ?: return null
        val cacheFile = File(cacheDir, record.getString("cacheId"))
        return if (cacheFile.exists()) cacheFile.readBytes() else null
    }

    private fun reEncrypt(file: File, relPath: String): JSONObject {
        val dek = AesGcm.randomKey()
        val ciphertext = AesGcm.encrypt(dek, file.readBytes())
        val cacheId = UUID.randomUUID().toString()
        File(cacheDir, cacheId).writeBytes(ciphertext)

        return JSONObject().apply {
            put("cacheId", cacheId)
            put("sizeBytes", ciphertext.size.toLong())
            put("contentHash", sha256Hex(ciphertext))
            put("mimeType", guessMimeType(file.name))
            put("wrappedDek", keyManager.wrapDek(dek))
            put("sourceLastModified", file.lastModified())
        }
    }

    private fun guessMimeType(name: String): String? {
        val ext = name.substringAfterLast('.', "")
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)
    }

    private fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    private fun loadMetadata(): JSONObject =
        if (metadataFile.exists()) JSONObject(metadataFile.readText()) else JSONObject()

    private fun saveMetadata(obj: JSONObject) = metadataFile.writeText(obj.toString())
}
