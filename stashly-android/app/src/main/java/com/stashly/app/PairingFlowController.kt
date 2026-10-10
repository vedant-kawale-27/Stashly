/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

package com.stashly.app

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.StatFs
import android.provider.DocumentsContract
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.util.Locale

/**
 * Owns the pairing + access-scope selection flow — the single biggest
 * chunk of business logic that was previously in [MainActivity].
 *
 * UI side-effects (dialogs, toasts, page changes) are delivered via
 * callbacks so the Activity retains control of View/Context usage.
 */
class PairingFlowController(
    private val storage: SecureStorage,
    private val viewModel: MainViewModel
) {

    // ── QR code parsing ──

    /** Result of parsing a scanned QR code. */
    sealed class QrParseResult {
        /** JSON or URL payload — auto-pair with extracted broker URL and/or token. */
        data class AutoPair(val brokerUrl: String?, val token: String?) : QrParseResult()
        /** Raw pairing code only (e.g. 8-char code). */
        data class TokenOnly(val token: String, val hasBrokerUrl: Boolean) : QrParseResult()
        /** Parsing failed. */
        data class Error(val message: String) : QrParseResult()
    }

    /**
     * Parse a scanned QR code into a [QrParseResult].
     * Pure logic — no UI or Context dependency.
     * @param hasBrokerUrl true if the broker URL input already has a value.
     */
    fun parseScannedQr(rawText: String, hasBrokerUrl: Boolean): QrParseResult {
        val text = rawText.trim()
        try {
            // Case 1: Structured JSON payload
            if (text.startsWith("{") && text.endsWith("}")) {
                val json = JSONObject(text)
                val url = json.optString("brokerUrl", "").trim()
                val token = json.optString("token", "").trim()
                return QrParseResult.AutoPair(url.ifEmpty { null }, token.ifEmpty { null })
            }
            // Case 2: URL with query parameters
            if (text.contains("token=") || text.startsWith("http://") || text.startsWith("https://")) {
                val uri = Uri.parse(text)
                val token = uri.getQueryParameter("token") ?: ""
                val url = uri.getQueryParameter("url") ?: if (text.startsWith("http")) text else ""
                return QrParseResult.AutoPair(url.ifEmpty { null }, token.ifEmpty { null })
            }
            // Case 3: Raw pairing code only
            return QrParseResult.TokenOnly(text.uppercase(Locale.ROOT), hasBrokerUrl)
        } catch (e: Exception) {
            return QrParseResult.Error(e.message ?: "")
        }
    }

    // ── Device info ──

    data class DeviceInfo(
        val modelName: String,
        val modelNumber: String,
        val androidVersion: String,
        val osVersion: String,
        val appVersion: String,
        val batteryLevel: Int?,
        val storageTotalMb: Int?,
        val storageFreeMb: Int?,
        val sdcardMounted: Boolean = false,
        val sdcardTotalMb: Int? = null,
        val sdcardFreeMb: Int? = null
    )

    fun readDeviceInfo(context: Context): DeviceInfo {
        val stat = StatFs(Environment.getExternalStorageDirectory().path)
        fun toMb(value: Long): Int = (value / (1024L * 1024L)).coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
        val batteryManager = context.getSystemService(Context.BATTERY_SERVICE) as android.os.BatteryManager
        val battery = batteryManager.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY)
            .takeIf { it in 0..100 }

        var sdcardTotalMb: Int? = null
        var sdcardFreeMb: Int? = null
        var sdcardMounted = false

        if (storage.sdcardAccessEnabled) {
            try {
                val removableFile = StorageUtils.getMountedSdCardFile(context)
                if (removableFile != null) {
                    val sdStat = StatFs(removableFile.path)
                    sdcardMounted = true
                    sdcardTotalMb = toMb(sdStat.totalBytes)
                    sdcardFreeMb = toMb(sdStat.availableBytes)
                }
            } catch (_: Exception) {}
        }

        return DeviceInfo(
            modelName = "${Build.MANUFACTURER} ${Build.MODEL}".trim(),
            modelNumber = Build.DEVICE,
            androidVersion = Build.VERSION.RELEASE ?: "Unknown",
            osVersion = Build.VERSION.RELEASE ?: "Unknown",
            appVersion = context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "Unknown",
            batteryLevel = battery,
            storageTotalMb = toMb(stat.totalBytes),
            storageFreeMb = toMb(stat.availableBytes),
            sdcardMounted = sdcardMounted,
            sdcardTotalMb = sdcardTotalMb,
            sdcardFreeMb = sdcardFreeMb
        )
    }

    // ── Pairing execution ──

    /**
     * Normalize and validate inputs, then execute the pairing handshake.
     * @param onValidationError inputs are empty.
     * @param onNeedsStoragePermission storage access not granted.
     * @param onPairingStarted show progress UI.
     * @param onPairingSuccess pairing succeeded — result and stopService callback.
     * @param onPairingError pairing failed.
     * @param onPairingFinished always called (finally) to restore UI.
     */
    fun executePairing(
        context: Context,
        rawBrokerUrl: String,
        deviceName: String,
        rawPairingToken: String,
        onValidationError: () -> Unit,
        onNeedsStoragePermission: () -> Unit,
        onPairingStarted: () -> Unit,
        onPairingSuccess: (result: PairingResult, onStopService: () -> Unit) -> Unit,
        onPairingError: (Exception, brokerUrl: String) -> Unit,
        onPairingFinished: () -> Unit
    ) {
        if (rawBrokerUrl.isEmpty() || deviceName.isEmpty() || rawPairingToken.isEmpty()) {
            onValidationError(); return
        }
        if (!SystemPermissionCoordinator.hasFullStorageAccess(context)) {
            onNeedsStoragePermission(); return
        }

        var brokerUrl = rawBrokerUrl
        val pairingToken = rawPairingToken.uppercase(Locale.ROOT)
        if (!brokerUrl.startsWith("http://", ignoreCase = true) &&
            !brokerUrl.startsWith("https://", ignoreCase = true)
        ) {
            brokerUrl = "http://$brokerUrl"
        }
        brokerUrl = brokerUrl.trimEnd('/')

        onPairingStarted()
        val targetUrl = brokerUrl
        CoroutineScope(Dispatchers.Main).launch {
            try {
                val deviceInfo = readDeviceInfo(context)
                val result = withContext(Dispatchers.IO) {
                    PairingRepository.pair(
                        targetUrl, pairingToken, deviceName,
                        existingDeviceId = storage.deviceId,
                        modelName = deviceInfo.modelName,
                        modelNumber = deviceInfo.modelNumber,
                        androidVersion = deviceInfo.androidVersion,
                        osVersion = deviceInfo.osVersion,
                        appVersion = deviceInfo.appVersion,
                        batteryLevel = deviceInfo.batteryLevel,
                        storageTotalMb = deviceInfo.storageTotalMb,
                        storageFreeMb = deviceInfo.storageFreeMb,
                        sdcardMounted = deviceInfo.sdcardMounted,
                        sdcardTotalMb = deviceInfo.sdcardTotalMb,
                        sdcardFreeMb = deviceInfo.sdcardFreeMb
                    )
                }
                storage.brokerBaseUrl = targetUrl
                storage.deviceId = result.deviceId
                storage.deviceToken = result.deviceToken
                storage.currentUserId = result.userId
                if (result.role == "owner") {
                    storage.ownerUserId = result.userId
                    storage.ownerDeviceToken = result.deviceToken
                }
                if (result.userEmail != null) {
                    storage.userEmail = result.userEmail
                }
                KeyManager(storage).getOrCreateMasterKey()
                storage.nodeEnabled = false
                viewModel.pendingScopeIsPairing = true
                onPairingSuccess(result) {
                    // onStopService callback — Activity calls stopService
                }
            } catch (e: Exception) {
                onPairingError(e, targetUrl)
            } finally {
                onPairingFinished()
            }
        }
    }

    // ── Access-scope handling (folder/file picker results) ──

    /**
     * Process a folder picker result: take URI permission and return the scope.
     * Returns null if no pending pairing exists.
     */
    fun parseFolderScope(uri: Uri, contentResolver: ContentResolver): AccessScope? {
        if (viewModel.pendingScopePairing == null) return null
        try {
            contentResolver.takePersistableUriPermission(
                uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            )
        } catch (_: Exception) {}
        val selection = viewModel.getFolderSelection(uri)
        return AccessScope("CUSTOM_FOLDER", selection.virtualPath, selection.displayName)
    }

    /**
     * Process a file picker result: take URI permission and return the scope.
     * Returns null if no pending pairing exists.
     */
    fun parseFileScope(uri: Uri, contentResolver: ContentResolver): AccessScope? {
        if (viewModel.pendingScopePairing == null) return null
        try {
            contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } catch (_: Exception) {}
        val documentId = runCatching { DocumentsContract.getDocumentId(uri) }.getOrNull()
            ?: uri.lastPathSegment.orEmpty()
        val split = documentId.split(":")
        val relativePath = split.getOrNull(1)?.trim('/') ?: documentId.trim('/')
        val virtualPath = if (relativePath.isEmpty()) "/" else "/$relativePath"
        val displayName = relativePath.substringAfterLast('/').ifEmpty { "Selected file" }
        return AccessScope("CUSTOM_FILE", virtualPath, displayName)
    }

    /**
     * Save the chosen access scope to the broker and start the node.
     * @param onStartService start the foreground service.
     * @param onSuccess called with isPairing flag (true = initial pairing, false = scope edit).
     * @param onError called with the error message.
     */
    fun savePairingScope(
        context: Context,
        pairing: PairingResult,
        scope: AccessScope,
        onStartService: () -> Unit,
        onSuccess: (isPairing: Boolean) -> Unit,
        onError: (String) -> Unit
    ) {
        if (!SystemPermissionCoordinator.hasFullStorageAccess(context)) return
        val brokerUrl = storage.brokerBaseUrl ?: return
        val deviceToken = pairing.deviceToken
        val isPairing = viewModel.pendingScopeIsPairing
        val targetUserId = viewModel.pendingScopeTargetUserId
        viewModel.pendingScopePairing = null

        CoroutineScope(Dispatchers.Main).launch {
            try {
                withContext(Dispatchers.IO) {
                    PairingRepository.updateAccessScope(brokerUrl, deviceToken, scope, targetUserId)
                }
                storage.nodeEnabled = true
                onStartService()
                onSuccess(isPairing)
            } catch (e: Exception) {
                onError(e.message ?: "")
            }
        }
    }
}
