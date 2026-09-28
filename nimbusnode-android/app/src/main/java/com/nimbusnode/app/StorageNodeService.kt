package com.nimbusnode.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * The always-running piece: keeps one persistent WebSocket connection to the
 * broker alive so this phone stays reachable for file requests regardless of
 * whether it's physically nearby. Runs as a foreground service with a
 * visible notification.
 */
class StorageNodeService : Service() {

    private lateinit var socketClient: BrokerSocketClient
    private lateinit var connectivityManager: ConnectivityManager
    private lateinit var storage: SecureStorage
    private var currentState: BrokerSocketClient.State = BrokerSocketClient.State.CONNECTING

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            socketClient.start()
        }
    }

    override fun onCreate() {
        super.onCreate()
        storage = SecureStorage(this)
        val keyManager = KeyManager(storage)
        val fileVault = FileVault(this, keyManager, storage)

        socketClient = BrokerSocketClient(
            brokerBaseUrl = storage.brokerBaseUrl ?: "",
            deviceId = storage.deviceId ?: "",
            deviceToken = storage.deviceToken ?: "",
            fileVault = fileVault,
            onStateChange = ::updateNotification
        )

        connectivityManager = getSystemService(ConnectivityManager::class.java)
        connectivityManager.registerDefaultNetworkCallback(networkCallback)

        createNotificationChannel()
        startForeground(NOTIFICATION_ID, buildNotification(currentState))
        socketClient.start()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_SYNC_NOW && ::socketClient.isInitialized) {
            socketClient.pushFileSync()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        if (::storage.isInitialized) {
            storage.isLive = false
            storage.lastLiveTimestamp = System.currentTimeMillis()
        }
        socketClient.stop()
        connectivityManager.unregisterNetworkCallback(networkCallback)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun updateNotification(state: BrokerSocketClient.State) {
        currentState = state
        if (::storage.isInitialized) {
            val isOnline = (state == BrokerSocketClient.State.ONLINE)
            storage.isLive = isOnline
            if (isOnline) {
                storage.lastLiveTimestamp = System.currentTimeMillis()
            }
        }
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, buildNotification(state))
    }

    private fun buildNotification(state: BrokerSocketClient.State): Notification {
        val text = when (state) {
            BrokerSocketClient.State.CONNECTING -> getString(R.string.notification_text_connecting)
            BrokerSocketClient.State.ONLINE -> getString(R.string.notification_text_online)
            BrokerSocketClient.State.OFFLINE -> getString(R.string.notification_text_offline)
        }

        val openAppIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentIntent(openAppIntent)
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
        const val ACTION_SYNC_NOW = "com.nimbusnode.app.action.SYNC_NOW"
        private const val CHANNEL_ID = "storage_node_status"
        private const val NOTIFICATION_ID = 1
    }
}
