/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

package com.stashly.app

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Wraps EncryptedSharedPreferences (backed by the Android Keystore) for the
 * secrets/config this app needs to keep locally: which broker to talk to,
 * device id/token, user email, pairing status, and live connection timestamp.
 */
class SecureStorage(context: Context) {

    private val prefs: SharedPreferences

    init {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()

        prefs = EncryptedSharedPreferences.create(
            context,
            "stashly_secure_prefs",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    var brokerBaseUrl: String?
        get() = prefs.getString(KEY_BROKER_URL, null)
        set(value) = prefs.edit().putString(KEY_BROKER_URL, value).apply()

    var deviceId: String?
        get() = prefs.getString(KEY_DEVICE_ID, null)
        set(value) = prefs.edit().putString(KEY_DEVICE_ID, value).apply()

    var deviceToken: String?
        get() = prefs.getString(KEY_DEVICE_TOKEN, null)
        set(value) = prefs.edit().putString(KEY_DEVICE_TOKEN, value).apply()

    var userEmail: String?
        get() = prefs.getString(KEY_USER_EMAIL, null)
        set(value) = prefs.edit().putString(KEY_USER_EMAIL, value).apply()

    var currentUserId: String?
        get() = prefs.getString(KEY_CURRENT_USER_ID, null)
        set(value) = prefs.edit().putString(KEY_CURRENT_USER_ID, value).apply()

    var ownerUserId: String?
        get() = prefs.getString(KEY_OWNER_USER_ID, null)
        set(value) = prefs.edit().putString(KEY_OWNER_USER_ID, value).apply()

    var ownerDeviceToken: String?
        get() = prefs.getString(KEY_OWNER_DEVICE_TOKEN, null)
        set(value) = prefs.edit().putString(KEY_OWNER_DEVICE_TOKEN, value).apply()

    var masterKeyBase64: String?
        get() = prefs.getString(KEY_MASTER_KEY, null)
        set(value) = prefs.edit().putString(KEY_MASTER_KEY, value).apply()

    val isPaired: Boolean
        get() = deviceId != null && deviceToken != null && brokerBaseUrl != null

    var nodeEnabled: Boolean
        get() = prefs.getBoolean(KEY_NODE_ENABLED, true)
        set(value) = prefs.edit().putBoolean(KEY_NODE_ENABLED, value).apply()

    var isLive: Boolean
        get() = prefs.getBoolean(KEY_IS_LIVE, false)
        set(value) = prefs.edit().putBoolean(KEY_IS_LIVE, value).apply()

    var lastLiveTimestamp: Long
        get() = prefs.getLong(KEY_LAST_LIVE, 0L)
        set(value) = prefs.edit().putLong(KEY_LAST_LIVE, value).apply()

    var storageScopeMode: String
        get() = prefs.getString(KEY_STORAGE_SCOPE_MODE, "ALL") ?: "ALL"
        set(value) = prefs.edit().putString(KEY_STORAGE_SCOPE_MODE, value).apply()

    var customFolderPath: String?
        get() = prefs.getString(KEY_CUSTOM_FOLDER_PATH, null)
        set(value) = prefs.edit().putString(KEY_CUSTOM_FOLDER_PATH, value).apply()

    var customFolderUri: String?
        get() = prefs.getString(KEY_CUSTOM_FOLDER_URI, null)
        set(value) = prefs.edit().putString(KEY_CUSTOM_FOLDER_URI, value).apply()

    var customFolderDisplayName: String?
        get() = prefs.getString(KEY_CUSTOM_FOLDER_NAME, null)
        set(value) = prefs.edit().putString(KEY_CUSTOM_FOLDER_NAME, value).apply()

    var connectedUsersJson: String?
        get() = prefs.getString(KEY_CONNECTED_USERS, null)
        set(value) = prefs.edit().putString(KEY_CONNECTED_USERS, value).apply()

    var pendingClientRemovedUserId: String?
        get() = prefs.getString(KEY_PENDING_CLIENT_REMOVED, null)
        set(value) = prefs.edit().putString(KEY_PENDING_CLIENT_REMOVED, value).apply()

    var pendingFinalRemovalReason: String?
        get() = prefs.getString(KEY_PENDING_FINAL_REMOVAL, null)
        set(value) = prefs.edit().putString(KEY_PENDING_FINAL_REMOVAL, value).apply()

    fun clear() = prefs.edit().clear().apply()

    companion object {
        private const val KEY_BROKER_URL = "broker_base_url"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_DEVICE_TOKEN = "device_token"
        private const val KEY_USER_EMAIL = "user_email"
        private const val KEY_CURRENT_USER_ID = "current_user_id"
        private const val KEY_OWNER_USER_ID = "owner_user_id"
        private const val KEY_OWNER_DEVICE_TOKEN = "owner_device_token"
        private const val KEY_MASTER_KEY = "master_key"
        private const val KEY_NODE_ENABLED = "node_enabled"
        private const val KEY_IS_LIVE = "is_live"
        private const val KEY_LAST_LIVE = "last_live"
        private const val KEY_STORAGE_SCOPE_MODE = "storage_scope_mode"
        private const val KEY_CUSTOM_FOLDER_PATH = "custom_folder_path"
        private const val KEY_CUSTOM_FOLDER_URI = "custom_folder_uri"
        private const val KEY_CUSTOM_FOLDER_NAME = "custom_folder_name"
        private const val KEY_CONNECTED_USERS = "connected_users"
        private const val KEY_PENDING_CLIENT_REMOVED = "pending_client_removed"
        private const val KEY_PENDING_FINAL_REMOVAL = "pending_final_removal"
    }
}
