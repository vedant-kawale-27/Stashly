package com.nimbusnode.app

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Wraps EncryptedSharedPreferences (backed by the Android Keystore) for the
 * handful of secrets/config this app needs to keep locally: which broker to
 * talk to, this device's id/token, and pairing status. None of this is ever
 * sent anywhere except the initial pairing call and the device's own
 * authenticated WebSocket connection.
 */
class SecureStorage(context: Context) {

    private val prefs: SharedPreferences

    init {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()

        prefs = EncryptedSharedPreferences.create(
            context,
            "nimbusnode_secure_prefs",
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

    // Raw AES-256 account master key, base64-encoded. At rest this is
    // protected by the Keystore-backed encryption EncryptedSharedPreferences
    // already provides; in memory it's held only as long as needed to
    // wrap/unwrap a DEK. See KeyManager for the known multi-device caveat.
    var masterKeyBase64: String?
        get() = prefs.getString(KEY_MASTER_KEY, null)
        set(value) = prefs.edit().putString(KEY_MASTER_KEY, value).apply()

    val isPaired: Boolean
        get() = deviceId != null && deviceToken != null && brokerBaseUrl != null

    // Tracks whether the user wants the storage node running — distinct
    // from isPaired, so tapping "Stop" persists across app restarts and
    // reboots instead of BootReceiver/onCreate silently starting it back up.
    var nodeEnabled: Boolean
        get() = prefs.getBoolean(KEY_NODE_ENABLED, true) // defaults on once paired
        set(value) = prefs.edit().putBoolean(KEY_NODE_ENABLED, value).apply()

    fun clear() = prefs.edit().clear().apply()

    companion object {
        private const val KEY_BROKER_URL = "broker_base_url"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_DEVICE_TOKEN = "device_token"
        private const val KEY_MASTER_KEY = "master_key"
        private const val KEY_NODE_ENABLED = "node_enabled"
    }
}
