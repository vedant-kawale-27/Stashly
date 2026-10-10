/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

package com.stashly.app

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Environment
import android.os.StatFs
import android.widget.RemoteViews
import androidx.core.content.ContextCompat
import org.json.JSONArray
import java.util.Locale

class StashlyWidgetProvider : AppWidgetProvider() {

    override fun onUpdate(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) {
        appWidgetIds.forEach { updateWidget(context, manager, it) }
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        val storage = SecureStorage(context)
        when (intent.action) {
            ACTION_TOGGLE_NODE -> {
                if (storage.isPaired) {
                    storage.nodeEnabled = !storage.nodeEnabled
                    if (storage.nodeEnabled) {
                        ContextCompat.startForegroundService(context, Intent(context, StorageNodeService::class.java))
                    } else {
                        context.stopService(Intent(context, StorageNodeService::class.java))
                    }
                }
                updateAll(context)
            }
            ACTION_SYNC_NOW -> {
                if (storage.isPaired && storage.nodeEnabled) {
                    ContextCompat.startForegroundService(
                        context,
                        Intent(context, StorageNodeService::class.java).setAction(StorageNodeService.ACTION_SYNC_NOW)
                    )
                }
                updateAll(context)
            }
        }
    }

    companion object {
        private const val ACTION_TOGGLE_NODE = "com.stashly.app.widget.TOGGLE_NODE"
        private const val ACTION_SYNC_NOW = "com.stashly.app.widget.SYNC_NOW"

        fun updateAll(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val component = ComponentName(context, StashlyWidgetProvider::class.java)
            manager.getAppWidgetIds(component).forEach { updateWidget(context, manager, it) }
        }

        private fun updateWidget(context: Context, manager: AppWidgetManager, widgetId: Int) {
            val views = RemoteViews(context.packageName, R.layout.widget_stashly)
            val storage = runCatching { SecureStorage(context) }.getOrNull()
            val paired = storage?.isPaired == true
            val running = paired && storage?.nodeEnabled == true

            val stat = runCatching { StatFs(Environment.getExternalStorageDirectory().path) }.getOrNull()
            val totalBytes = stat?.totalBytes ?: 0L
            val freeBytes = stat?.availableBytes ?: 0L
            val usedPercent = if (totalBytes > 0) {
                ((totalBytes - freeBytes).toDouble() / totalBytes * 100).toInt().coerceIn(0, 100)
            } else 0

            views.setProgressBar(R.id.widgetStorageBar, 100, usedPercent, false)
            val usedBytes = (totalBytes - freeBytes).coerceAtLeast(0L)
            views.setTextViewText(R.id.widgetStorageUsed, "Used ${formatBytes(usedBytes)}")
            views.setTextViewText(R.id.widgetStorageFree, "Free ${formatBytes(freeBytes)}")
            views.setTextViewText(R.id.widgetStorageTotal, "Total ${formatBytes(totalBytes)}")

            val users = runCatching { JSONArray(storage?.connectedUsersJson ?: "[]") }.getOrDefault(JSONArray())
            val totalUsers = users.length()
            val onlineUsers = (0 until totalUsers).count { index ->
                val user = users.optJSONObject(index)
                user?.optBoolean("sharingEnabled", true) == true && user.optBoolean("isLive", false) && running
            }
            val isLive = storage?.isLive == true
            views.setTextViewText(R.id.widgetClientSummary, "$onlineUsers/$totalUsers online connected clients")
            views.setTextViewText(
                R.id.widgetNodeStatus,
                when {
                    !paired -> "Stashly · Not paired"
                    !running -> "Stashly · Stopped"
                    isLive -> "Stashly · Active"
                    else -> "Stashly · Broker unavailable"
                }
            )
            views.setTextViewText(R.id.widgetToggleButton, if (running) "Stop" else "Start")
            views.setBoolean(R.id.widgetToggleButton, "setEnabled", paired)
            views.setBoolean(R.id.widgetSyncButton, "setEnabled", running && isLive)

            views.setOnClickPendingIntent(R.id.widgetToggleButton, actionPendingIntent(context, ACTION_TOGGLE_NODE))
            views.setOnClickPendingIntent(R.id.widgetSyncButton, actionPendingIntent(context, ACTION_SYNC_NOW))
            views.setOnClickPendingIntent(R.id.widgetNodeStatus, openAppPendingIntent(context))
            manager.updateAppWidget(widgetId, views)
        }

        private fun actionPendingIntent(context: Context, action: String): PendingIntent {
            val intent = Intent(context, StashlyWidgetProvider::class.java).setAction(action)
            return PendingIntent.getBroadcast(
                context,
                action.hashCode(),
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or immutableFlag()
            )
        }

        private fun openAppPendingIntent(context: Context): PendingIntent {
            val intent = context.packageManager.getLaunchIntentForPackage(context.packageName)
                ?: Intent(context, MainActivity::class.java)
            return PendingIntent.getActivity(
                context,
                1001,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or immutableFlag()
            )
        }

        private fun immutableFlag(): Int = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_IMMUTABLE
        } else 0

        private fun formatBytes(bytes: Long): String {
            val gb = bytes.toDouble() / (1024 * 1024 * 1024)
            return if (gb >= 1) String.format(Locale.getDefault(), "%.1f GB", gb)
            else String.format(Locale.getDefault(), "%.0f MB", bytes / (1024 * 1024).toDouble())
        }
    }
}
