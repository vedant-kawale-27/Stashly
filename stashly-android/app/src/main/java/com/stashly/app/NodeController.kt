/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

package com.stashly.app

import android.content.Context
import android.os.Environment
import android.os.StatFs
import androidx.core.content.ContextCompat
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.TimeUnit

/**
 * Owns node lifecycle logic: start/stop, sync, reset, status refresh.
 * Publishes results through [MainViewModel]; does NOT touch views directly.
 * UI side-effects (toasts, service intents) are delivered via callbacks.
 */
class NodeController(
    private val storage: SecureStorage,
    private val viewModel: MainViewModel
) {

    fun scheduleTrashCleanup(context: Context) {
        val request = PeriodicWorkRequestBuilder<TrashCleanupWorker>(1, TimeUnit.DAYS).build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            "stashly_trash_cleanup",
            ExistingPeriodicWorkPolicy.KEEP,
            request,
        )
    }

    /**
     * Toggle the node on/off.
     * @param onStartService called when the foreground service should be started.
     * @param onStopService called when the foreground service should be stopped.
     * @param onNotPaired called when the device is not paired yet.
     * @param onStatusChange called after the toggle with (started=true/false).
     */
    fun toggleNode(
        onStartService: () -> Unit,
        onStopService: () -> Unit,
        onNotPaired: () -> Unit,
        onStatusChange: (started: Boolean) -> Unit
    ) {
        if (!storage.isPaired) { onNotPaired(); return }
        if (storage.nodeEnabled) {
            storage.nodeEnabled = false
            storage.isLive = false
            storage.brokerConnectionState = "OFFLINE"
            onStopService()
            onStatusChange(false)
        } else {
            storage.nodeEnabled = true
            storage.brokerConnectionState = "CONNECTING"
            onStartService()
            onStatusChange(true)
        }
    }

    /**
     * Trigger a manual sync.
     * @param onSendSyncIntent called to send the SYNC_NOW intent to the service.
     */
    fun syncNow(onSendSyncIntent: () -> Unit): Boolean {
        if (!storage.isPaired) return false
        onSendSyncIntent()
        return true
    }

    /** Refresh ViewModel node/storage state from [SecureStorage]. */
    fun refreshNodeStatus() {
        val isPaired = storage.isPaired
        val isRunning = isPaired && storage.nodeEnabled
        viewModel.nodePaired = isPaired
        viewModel.nodeRunning = isRunning
        viewModel.isLive = if (isRunning) storage.isLive else false
        viewModel.brokerConnectionState = if (isRunning) storage.brokerConnectionState else "OFFLINE"
        viewModel.brokerUrl = storage.brokerBaseUrl
        if (isPaired) {
            viewModel.lastSyncTime = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())
            viewModel.connectedUsers = viewModel.loadCachedConnectedUsers(storage)
        }
    }

    /** Compute storage meter data and store in ViewModel. */
    fun refreshStorageMeter() {
        try {
            val path = Environment.getDataDirectory()
            val stat = StatFs(path.path)
            val blockSize = stat.blockSizeLong
            val totalBlocks = stat.blockCountLong
            val availableBlocks = stat.availableBlocksLong
            val totalBytes = totalBlocks * blockSize
            val freeBytes = availableBlocks * blockSize
            val usedBytes = totalBytes - freeBytes
            viewModel.storageMeterData = StorageMeterData(
                usedGb = usedBytes.toDouble() / (1024 * 1024 * 1024),
                freeGb = freeBytes.toDouble() / (1024 * 1024 * 1024),
                totalGb = totalBytes.toDouble() / (1024 * 1024 * 1024),
                usedPercent = if (totalBytes > 0) ((usedBytes.toDouble() / totalBytes) * 100).toInt() else 0
            )
        } catch (_: Exception) {
            viewModel.storageMeterData = null
        }
    }

    /** Compute SD card meter data and store in ViewModel. */
    fun refreshSdCardMeter(context: Context) {
        if (!StorageUtils.hasSdCardSupport(context)) {
            viewModel.sdCardMeterData = SdCardMeterData(isSupported = false, isMounted = false)
            return
        }

        if (!storage.sdcardAccessEnabled) {
            viewModel.sdCardMeterData = SdCardMeterData(isSupported = true, isMounted = false)
            return
        }

        try {
            val removableFile = StorageUtils.getMountedSdCardFile(context)
            if (removableFile != null) {
                val stat = StatFs(removableFile.path)
                val blockSize = stat.blockSizeLong
                val totalBlocks = stat.blockCountLong
                val availableBlocks = stat.availableBlocksLong
                val totalBytes = totalBlocks * blockSize
                val freeBytes = availableBlocks * blockSize
                val usedBytes = (totalBytes - freeBytes).coerceAtLeast(0L)
                val totalGb = totalBytes.toDouble() / (1024 * 1024 * 1024)
                val freeGb = freeBytes.toDouble() / (1024 * 1024 * 1024)
                val usedGb = usedBytes.toDouble() / (1024 * 1024 * 1024)
                val usedPercent = if (totalBytes > 0) ((usedBytes.toDouble() / totalBytes) * 100).toInt() else 0

                viewModel.sdCardMeterData = SdCardMeterData(
                    isSupported = true,
                    isMounted = true,
                    usedGb = usedGb,
                    freeGb = freeGb,
                    totalGb = totalGb,
                    usedPercent = usedPercent,
                    path = removableFile.absolutePath
                )
                return
            }

            viewModel.sdCardMeterData = SdCardMeterData(isSupported = true, isMounted = false)
        } catch (_: Exception) {
            viewModel.sdCardMeterData = SdCardMeterData(isSupported = true, isMounted = false)
        }
    }

    /**
     * Execute the server-side reset, then call back for local cleanup.
     * If no broker credentials exist, skips straight to [onLocalReset].
     */
    fun executeReset(onLocalReset: () -> Unit, onError: (String) -> Unit) {
        val brokerUrl = storage.brokerBaseUrl
        val deviceToken = storage.deviceToken
        if (brokerUrl.isNullOrEmpty() || deviceToken.isNullOrEmpty()) {
            onLocalReset(); return
        }
        CoroutineScope(Dispatchers.Main).launch {
            try {
                withContext(Dispatchers.IO) { PairingRepository.resetNode(brokerUrl, deviceToken) }
                onLocalReset()
            } catch (e: Exception) {
                onError(e.message ?: "")
            }
        }
    }

    /**
     * Perform the local cleanup after a node reset (stop service, clear vault, wipe storage).
     * @param onStopService stop the foreground service.
     * @param onDone called after cleanup is complete so the Activity can refresh UI.
     */
    fun finishLocalNodeReset(context: Context, onStopService: () -> Unit, onDone: () -> Unit) {
        onStopService()
        FileVault(context, KeyManager(storage), storage).clearVaultCache()
        storage.clear()
        onDone()
    }
}
