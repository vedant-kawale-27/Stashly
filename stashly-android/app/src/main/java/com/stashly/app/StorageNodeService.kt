/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

package com.stashly.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.os.IBinder
import android.os.Handler
import android.os.Looper
import androidx.core.app.NotificationCompat
import org.json.JSONArray

/**
 * The always-running piece: keeps one persistent WebSocket connection to the
 * broker alive so this phone stays reachable for file requests regardless of
 * whether it's physically nearby. Runs as a foreground service with a
 * visible notification.
 */
class StorageNodeService : Service() {

    private lateinit var socketClient: BrokerSocketClient
    private lateinit var fileVault: FileVault
    private lateinit var connectivityManager: ConnectivityManager
    private lateinit var storage: SecureStorage
    private var currentState: BrokerSocketClient.State = BrokerSocketClient.State.CONNECTING
    private val maintenanceHandler = Handler(Looper.getMainLooper())
    private val trashCleanup = object : Runnable {
        override fun run() {
            if (::fileVault.isInitialized) fileVault.purgeExpiredTrash()
            maintenanceHandler.postDelayed(this, 24L * 60 * 60 * 1000)
        }
    }

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            socketClient.start()
        }
    }

    override fun onCreate() {
        super.onCreate()
        storage = SecureStorage(this)
        val keyManager = KeyManager(storage)
        fileVault = FileVault(this, keyManager, storage)
        // Keep the local recycle bin bounded even when the UI is not opened.
        fileVault.purgeExpiredTrash()

        socketClient = BrokerSocketClient(
            context = this,
            brokerBaseUrl = storage.brokerBaseUrl ?: "",
            deviceId = storage.deviceId ?: "",
            deviceToken = storage.deviceToken ?: "",
            fileVault = fileVault,
            onStateChange = ::updateNotification,
            onNodeRemoved = ::handleNodeRemoved,
            onClientRemoved = ::handleClientRemoved,
            onClientPresence = ::handleClientPresence
        )

        connectivityManager = getSystemService(ConnectivityManager::class.java)
        connectivityManager.registerDefaultNetworkCallback(networkCallback)

        createNotificationChannel()
        startForeground(NOTIFICATION_ID, buildNotification(currentState))
        maintenanceHandler.postDelayed(trashCleanup, 24L * 60 * 60 * 1000)
        socketClient.start()
    }

    private fun handleNodeRemoved(reason: String) {
        val pendingClient = storage.pendingClientRemovedUserId
        if (::storage.isInitialized) {
            storage.clear()
            if (pendingClient != null) {
                storage.pendingClientRemovedUserId = pendingClient
                storage.pendingFinalRemovalReason = reason
            }
        }
        stopForeground(STOP_FOREGROUND_REMOVE)
        val manager = getSystemService(NotificationManager::class.java)
        manager.cancel(NOTIFICATION_ID)
        val intent = Intent(ACTION_NODE_UNLINKED).apply {
            setPackage(packageName)
            putExtra(EXTRA_UNLINK_REASON, reason)
        }
        sendBroadcast(intent)
        stopSelf()
    }

    private fun handleClientRemoved(userId: String) {
        storage.pendingClientRemovedUserId = userId
        updateCachedClientPresence(userId, removed = true)
        sendBroadcast(Intent(ACTION_CLIENT_UNLINKED).apply {
            setPackage(packageName)
            putExtra(EXTRA_CLIENT_USER_ID, userId)
        })
    }

    private fun handleClientPresence(userId: String, online: Boolean) {
        updateCachedClientPresence(userId, online = online)
        sendBroadcast(Intent(ACTION_CLIENT_PRESENCE).apply {
            setPackage(packageName)
            putExtra(EXTRA_CLIENT_USER_ID, userId)
            putExtra(EXTRA_CLIENT_ONLINE, online)
        })
    }

    private fun updateCachedClientPresence(userId: String, online: Boolean = false, removed: Boolean = false) {
        runCatching {
            val users = JSONArray(storage.connectedUsersJson ?: "[]")
            val updated = JSONArray()
            for (index in 0 until users.length()) {
                val user = users.getJSONObject(index)
                if (user.optString("userId") == userId) {
                    if (removed) continue
                    user.put("isLive", online)
                }
                updated.put(user)
            }
            storage.connectedUsersJson = updated.toString()
            StashlyWidgetProvider.updateAll(this)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP_NODE -> {
                stopNodeFromNotification()
                return START_NOT_STICKY
            }
            ACTION_SYNC_NOW -> {
                if (::socketClient.isInitialized) {
                    socketClient.pushFileSync()
                }
            }
        }
        StashlyWidgetProvider.updateAll(this)
        return START_STICKY
    }

    private fun stopNodeFromNotification() {
        if (::storage.isInitialized) {
            storage.nodeEnabled = false
            storage.isLive = false
            storage.brokerConnectionState = BrokerSocketClient.State.OFFLINE.name
            storage.lastLiveTimestamp = System.currentTimeMillis()
        }
        if (::socketClient.isInitialized) {
            // stop() sets the client guard before closing, so this deliberate stop
            // cannot be reported as an offline network failure or reconnect.
            socketClient.stop(clearRemoteFiles = true)
        }
        stopForeground(STOP_FOREGROUND_REMOVE)
        getSystemService(NotificationManager::class.java).cancel(NOTIFICATION_ID)
        stopSelf()
    }

    override fun onDestroy() {
        maintenanceHandler.removeCallbacks(trashCleanup)
        if (::storage.isInitialized) {
            storage.isLive = false
            storage.brokerConnectionState = BrokerSocketClient.State.OFFLINE.name
            storage.lastLiveTimestamp = System.currentTimeMillis()
        }
        if (::socketClient.isInitialized) {
            socketClient.stop()
        }
        if (::connectivityManager.isInitialized) {
            try {
                connectivityManager.unregisterNetworkCallback(networkCallback)
            } catch (_: Exception) {}
        }
        stopForeground(STOP_FOREGROUND_REMOVE)
        val manager = getSystemService(NotificationManager::class.java)
        manager.cancel(NOTIFICATION_ID)
        StashlyWidgetProvider.updateAll(this)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun updateNotification(state: BrokerSocketClient.State) {
        val stateChanged = (currentState != state)
        currentState = state
        if (::storage.isInitialized) {
            val isOnline = (state == BrokerSocketClient.State.ONLINE)
            storage.isLive = isOnline
            storage.brokerConnectionState = state.name
            if (isOnline) {
                storage.lastLiveTimestamp = System.currentTimeMillis()
            }
            if (stateChanged) {
                StashlyWidgetProvider.updateAll(this)
            }
        }
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, buildNotification(state))
        if (stateChanged) {
            sendBroadcast(Intent(ACTION_BROKER_STATE_CHANGED).apply {
                setPackage(packageName)
                putExtra(EXTRA_BROKER_STATE, state.name)
            })
        }
    }

    private fun buildNotification(state: BrokerSocketClient.State): Notification {
        val text = when (state) {
            BrokerSocketClient.State.CONNECTING -> getString(R.string.notification_text_connecting)
            BrokerSocketClient.State.ONLINE -> getString(R.string.notification_text_online)
            BrokerSocketClient.State.OFFLINE -> getString(R.string.notification_text_broker_unavailable)
        }

        val openAppIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )
        val stopIntent = PendingIntent.getService(
            this,
            STOP_REQUEST_CODE,
            Intent(this, StorageNodeService::class.java).setAction(ACTION_STOP_NODE),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentIntent(openAppIntent)
            .addAction(android.R.drawable.ic_media_pause, getString(R.string.notification_action_stop), stopIntent)
            .setOngoing(true)
            .build()
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notification_channel_name),
            NotificationManager.IMPORTANCE_LOW
        )
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    companion object {
        const val ACTION_SYNC_NOW = "com.stashly.app.action.SYNC_NOW"
        const val ACTION_STOP_NODE = "com.stashly.app.action.STOP_NODE"
        const val ACTION_NODE_UNLINKED = "com.stashly.app.action.NODE_UNLINKED"
        const val ACTION_CLIENT_UNLINKED = "com.stashly.app.action.CLIENT_UNLINKED"
        const val ACTION_CLIENT_PRESENCE = "com.stashly.app.action.CLIENT_PRESENCE"
        const val ACTION_BROKER_STATE_CHANGED = "com.stashly.app.action.BROKER_STATE_CHANGED"
        const val EXTRA_UNLINK_REASON = "extra_unlink_reason"
        const val EXTRA_CLIENT_USER_ID = "extra_client_user_id"
        const val EXTRA_CLIENT_ONLINE = "extra_client_online"
        const val EXTRA_BROKER_STATE = "extra_broker_state"
        private const val CHANNEL_ID = "storage_node_status"
        private const val NOTIFICATION_ID = 1
        private const val STOP_REQUEST_CODE = 2
    }
}
