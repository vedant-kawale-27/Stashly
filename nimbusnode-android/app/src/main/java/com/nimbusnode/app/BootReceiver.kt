package com.nimbusnode.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return

        val storage = SecureStorage(context)
        if (storage.isPaired) {
            context.startForegroundService(Intent(context, StorageNodeService::class.java))
        }
    }
}
