/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

package com.stashly.app

import android.net.Uri
import android.os.Environment
import android.provider.DocumentsContract
import androidx.lifecycle.ViewModel
import org.json.JSONArray
import java.io.File
import java.text.SimpleDateFormat
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Date
import java.util.Locale

/** Data class for storage meter display values. */
data class StorageMeterData(
    val usedGb: Double,
    val freeGb: Double,
    val totalGb: Double,
    val usedPercent: Int
)

/** Data class for SD card storage meter display values. */
data class SdCardMeterData(
    val isSupported: Boolean = true,
    val isMounted: Boolean = false,
    val usedGb: Double = 0.0,
    val freeGb: Double = 0.0,
    val totalGb: Double = 0.0,
    val usedPercent: Int = 0,
    val path: String? = null
)

/** Data class for parsed folder selection from a document tree URI. */
data class FolderSelection(
    val virtualPath: String,
    val displayName: String,
    val localPath: String
)

/** Activity-scoped UI state that should survive configuration changes. */
class MainViewModel : ViewModel() {
    var selectedPage: Int = 0
    var pendingScopePairing: PairingResult? = null
    var pendingScopeIsPairing: Boolean = true
    var pendingScopeTargetUserId: String? = null

    /** Cached list of connected users for rendering. */
    var connectedUsers: List<ConnectedUser> = emptyList()

    /** Current node state (refreshed by NodeController). */
    var nodePaired: Boolean = false
    var nodeRunning: Boolean = false
    var isLive: Boolean = false
    var brokerConnectionState: String = "OFFLINE"

    /** Broker connection info. */
    var brokerUrl: String? = null

    /** Last sync timestamp display string. */
    var lastSyncTime: String = ""

    /** Storage meter data for the storage page. */
    var storageMeterData: StorageMeterData? = null

    /** SD card meter data for the storage page. */
    var sdCardMeterData: SdCardMeterData? = null

    // ── Pure formatting helpers (no Context dependency) ──

    fun formatLastLive(timestamp: Long, neverLabel: String = "Never recorded"): String {
        return if (timestamp > 0) {
            val sdf = SimpleDateFormat("dd MMM, HH:mm:ss", Locale.getDefault())
            sdf.format(Date(timestamp))
        } else {
            neverLabel
        }
    }

    fun formatLastSeenOrTimestamp(lastSeenIso: String?, localTimestamp: Long, neverLabel: String = "Never recorded"): String {
        if (!lastSeenIso.isNullOrEmpty()) {
            try {
                return DateTimeFormatter.ofPattern("dd MMM yyyy, hh:mm a", Locale.getDefault())
                    .withZone(ZoneId.systemDefault())
                    .format(Instant.parse(lastSeenIso))
            } catch (_: Exception) {
                return lastSeenIso
            }
        }
        return formatLastLive(localTimestamp, neverLabel)
    }

    fun loadCachedConnectedUsers(storage: SecureStorage): List<ConnectedUser> {
        val jsonStr = storage.connectedUsersJson ?: return emptyList()
        val list = mutableListOf<ConnectedUser>()
        try {
            val array = JSONArray(jsonStr)
            for (i in 0 until array.length()) {
                val obj = array.getJSONObject(i)
                list.add(
                    ConnectedUser(
                        userId = obj.optString("userId").ifEmpty { null },
                        email = obj.getString("email"),
                        role = obj.optString("role", "viewer"),
                        scope = AccessScope(
                            mode = obj.optString("scopeMode", "ALL"),
                            path = obj.optString("scopePath").ifEmpty { null },
                            name = obj.optString("scopeName").ifEmpty { null }
                        ),
                        sharingEnabled = obj.optBoolean("sharingEnabled", true),
                        isLive = obj.optBoolean("isLive", false),
                        lastSeenAt = obj.optString("lastSeenAt").ifEmpty { null },
                        connectedAt = obj.optString("connectedAt").ifEmpty { null }
                    )
                )
            }
        } catch (_: Exception) {}
        return list
    }

    fun getFolderSelection(uri: Uri): FolderSelection {
        val docId = try {
            DocumentsContract.getTreeDocumentId(uri)
        } catch (_: Exception) {
            uri.lastPathSegment ?: ""
        }
        val split = docId.split(":")
        val type = split.getOrNull(0) ?: "primary"
        val relativePath = if (split.size > 1) split[1].trim('/') else ""
        val displayName = relativePath.substringAfterLast('/').ifEmpty { type }
        val virtualPath = if (relativePath.isEmpty()) "/" else "/$relativePath"
        val localPath = if (type.equals("primary", ignoreCase = true)) {
            File(Environment.getExternalStorageDirectory(), relativePath).absolutePath
        } else {
            "/storage/$type/$relativePath"
        }
        return FolderSelection(virtualPath, displayName, localPath)
    }
}
