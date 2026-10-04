/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

package com.stashly.app

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Owns connected-devices / sharing management logic.
 * Talks to [PairingRepository] for network calls and updates
 * [SecureStorage] + [MainViewModel] with results.
 * UI side-effects (render, toast, widget update) are delivered via callbacks.
 */
class ConnectedAccountsController(
    private val storage: SecureStorage,
    private val viewModel: MainViewModel
) {

    /**
     * Fetch live broker status (connected users, liveness) and update local state.
     * @param onUpdateWidget called on Main thread to refresh the home-screen widget.
     * @param onRenderUsers called on Main thread with the fresh user list for view binding.
     * @param onUpdateTimestamp called on Main thread with the formatted sync time.
     * @param onUnlinked called on Main thread when the broker reports this device is gone.
     */
    fun fetchLiveBrokerStatus(
        onUpdateWidget: () -> Unit,
        onRenderUsers: (List<ConnectedUser>) -> Unit,
        onUpdateTimestamp: (String) -> Unit,
        onUnlinked: () -> Unit
    ) {
        val brokerUrl = storage.brokerBaseUrl ?: return
        val deviceToken = storage.deviceToken ?: return
        if (!storage.isPaired) return

        CoroutineScope(Dispatchers.IO).launch {
            try {
                val selfInfo = PairingRepository.fetchSelfInfo(brokerUrl, deviceToken)
                withContext(Dispatchers.Main) {
                    val usersJson = JSONArray().apply {
                        selfInfo.users.forEach { u ->
                            put(JSONObject().apply {
                                put("email", u.email)
                                if (u.userId != null) put("userId", u.userId)
                                put("role", u.role)
                                put("scopeMode", u.scope.mode)
                                if (u.scope.path != null) put("scopePath", u.scope.path)
                                if (u.scope.name != null) put("scopeName", u.scope.name)
                                put("sharingEnabled", u.sharingEnabled)
                                put("isLive", u.isLive)
                                if (u.lastSeenAt != null) put("lastSeenAt", u.lastSeenAt)
                                if (u.connectedAt != null) put("connectedAt", u.connectedAt)
                            })
                        }
                    }.toString()
                    storage.connectedUsersJson = usersJson
                    onUpdateWidget()
                    if (selfInfo.users.isNotEmpty() && storage.userEmail.isNullOrEmpty()) {
                        storage.userEmail = selfInfo.users.first().email
                    }
                    selfInfo.users.firstOrNull {
                        it.userId == storage.currentUserId || it.email == storage.userEmail
                    }?.let { current ->
                        if (current.role == "owner" && current.userId != null) {
                            storage.ownerUserId = current.userId
                            storage.ownerDeviceToken = storage.deviceToken
                        }
                    }
                    viewModel.connectedUsers = selfInfo.users
                    onRenderUsers(selfInfo.users)
                    if (selfInfo.isLive) { storage.isLive = true }
                    val now = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())
                    viewModel.lastSyncTime = now
                    onUpdateTimestamp(now)
                }
            } catch (e: Exception) {
                val errorMsg = e.message.orEmpty()
                if (errorMsg.contains("401") || errorMsg.contains("404") ||
                    errorMsg.contains("Device not found", ignoreCase = true) ||
                    errorMsg.contains("Invalid", ignoreCase = true)
                ) {
                    withContext(Dispatchers.Main) { onUnlinked() }
                }
            }
        }
    }

    /**
     * Toggle sharing for a specific client.
     * @param onSuccess called on Main thread with the new enabled state.
     * @param onRefresh called on Main thread to re-fetch broker status.
     * @param onError called on Main thread with the error message.
     */
    fun setClientSharing(
        user: ConnectedUser,
        enabled: Boolean,
        onSuccess: (enabled: Boolean) -> Unit,
        onRefresh: () -> Unit,
        onError: (String) -> Unit
    ) {
        val brokerUrl = storage.brokerBaseUrl ?: return
        val deviceToken = storage.deviceToken ?: return
        val targetUserId = user.userId ?: return
        CoroutineScope(Dispatchers.Main).launch {
            try {
                withContext(Dispatchers.IO) {
                    PairingRepository.setClientSharing(brokerUrl, deviceToken, targetUserId, enabled)
                }
                onRefresh()
                onSuccess(enabled)
            } catch (e: Exception) {
                onError(e.message ?: "")
            }
        }
    }

    /**
     * Remove a client's connection entirely.
     * @param onSuccess called on Main thread after successful removal.
     * @param onRefresh called on Main thread to re-fetch broker status.
     * @param onError called on Main thread with the error message.
     */
    fun removeClientConnection(
        user: ConnectedUser,
        onSuccess: () -> Unit,
        onRefresh: () -> Unit,
        onError: (String) -> Unit
    ) {
        val brokerUrl = storage.brokerBaseUrl ?: return
        val deviceToken = storage.deviceToken ?: return
        val targetUserId = user.userId ?: return
        CoroutineScope(Dispatchers.Main).launch {
            try {
                withContext(Dispatchers.IO) {
                    PairingRepository.removeClientAccess(brokerUrl, deviceToken, targetUserId)
                }
                onRefresh()
                onSuccess()
            } catch (e: Exception) {
                onError(e.message ?: "")
            }
        }
    }
}
