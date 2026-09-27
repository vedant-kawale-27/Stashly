package com.nimbusnode.app

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.util.Base64
import android.view.View
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.nimbusnode.app.databinding.ActivityMainBinding
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var storage: SecureStorage

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        storage = SecureStorage(this)
        refreshStatus()

        binding.pairButton.setOnClickListener { onPairClicked() }
        binding.stopNodeButton.setOnClickListener { onStopNodeClicked() }
        binding.startNodeButton.setOnClickListener { onStartNodeClicked() }
        binding.batteryOptButton.setOnClickListener { requestIgnoreBatteryOptimizations() }
        binding.fullStorageAccessButton.setOnClickListener { requestFullStorageAccess() }
        binding.showMasterKeyButton.setOnClickListener { onShowMasterKeyClicked() }
        binding.syncNowButton.setOnClickListener { onSyncNowClicked() }

        if (storage.isPaired && storage.nodeEnabled) {
            startForegroundService(Intent(this, StorageNodeService::class.java))
        }
    }

    override fun onResume() {
        super.onResume()
        refreshStatus()
    }

    private fun onPairClicked() {
        val brokerUrl = binding.brokerUrlInput.text.toString().trim()
        val deviceName = binding.deviceNameInput.text.toString().trim()
        val pairingToken = binding.pairingTokenInput.text.toString().trim()

        if (brokerUrl.isEmpty() || deviceName.isEmpty() || pairingToken.isEmpty()) {
            Toast.makeText(this, "Fill in all three fields", Toast.LENGTH_SHORT).show()
            return
        }

        binding.pairButton.isEnabled = false
        CoroutineScope(Dispatchers.Main).launch {
            try {
                val result = withContext(Dispatchers.IO) {
                    PairingRepository.pair(brokerUrl, pairingToken, deviceName)
                }
                storage.brokerBaseUrl = brokerUrl
                storage.deviceId = result.deviceId
                storage.deviceToken = result.deviceToken
                storage.nodeEnabled = true

                // If a previous instance of the service is already running
                // (e.g. re-pairing after a broker DB reset), it read the old
                // credentials into memory at onCreate and won't notice these
                // new ones on its own — restart it so it picks them up.
                stopService(Intent(this@MainActivity, StorageNodeService::class.java))
                Toast.makeText(this@MainActivity, "Paired. Starting storage node…", Toast.LENGTH_SHORT).show()
                startForegroundService(Intent(this@MainActivity, StorageNodeService::class.java))
                refreshStatus()
            } catch (e: Exception) {
                Toast.makeText(this@MainActivity, "Pairing failed: ${e.message}", Toast.LENGTH_LONG).show()
            } finally {
                binding.pairButton.isEnabled = true
            }
        }
    }

    private fun onStartNodeClicked() {
        if (!storage.isPaired) {
            Toast.makeText(this, "Not paired yet — enter a pairing code first", Toast.LENGTH_SHORT).show()
            return
        }
        storage.nodeEnabled = true
        startForegroundService(Intent(this, StorageNodeService::class.java))
        Toast.makeText(this, "Storage node starting…", Toast.LENGTH_SHORT).show()
        refreshStatus()
    }

    private fun onStopNodeClicked() {
        storage.nodeEnabled = false
        stopService(Intent(this, StorageNodeService::class.java))
        Toast.makeText(this, "Storage node stopped", Toast.LENGTH_SHORT).show()
        refreshStatus()
    }

    private fun requestIgnoreBatteryOptimizations() {
        val pm = getSystemService(PowerManager::class.java)
        if (pm.isIgnoringBatteryOptimizations(packageName)) {
            Toast.makeText(this, "Already exempt from battery optimization", Toast.LENGTH_SHORT).show()
            return
        }
        // Must be a user-initiated, one-app-at-a-time request — batching this
        // silently or auto-launching it without user action gets apps rejected
        // from Play; keep this behind an explicit button tap.
        val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
            data = Uri.parse("package:$packageName")
        }
        startActivity(intent)
    }

    private fun onShowMasterKeyClicked() {
        // Generates the key on first call if this phone hasn't made one yet.
        // Treat this like a password reveal: it's shown once, on request, and
        // copied straight to the clipboard rather than left on screen by default.
        val keyManager = KeyManager(storage)
        val keyBase64 = Base64.encodeToString(keyManager.getOrCreateMasterKey(), Base64.NO_WRAP)

        binding.masterKeyText.text = keyBase64
        binding.masterKeyText.visibility = View.VISIBLE

        val clipboard = getSystemService(ClipboardManager::class.java)
        clipboard.setPrimaryClip(ClipData.newPlainText("NimbusNode master key", keyBase64))
        Toast.makeText(this, "Copied to clipboard — paste it into the web client", Toast.LENGTH_LONG).show()
    }

    private fun requestFullStorageAccess() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            Toast.makeText(this, "Not needed below Android 11 — falling back to the app folder", Toast.LENGTH_LONG).show()
            return
        }
        if (android.os.Environment.isExternalStorageManager()) {
            Toast.makeText(this, "Already granted", Toast.LENGTH_SHORT).show()
            return
        }
        // Must be a deliberate, user-initiated trip to Settings — Android
        // doesn't allow granting this permission via a plain runtime dialog.
        val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION).apply {
            data = Uri.parse("package:$packageName")
        }
        startActivity(intent)
    }

    private fun onSyncNowClicked() {
        if (!storage.isPaired) {
            Toast.makeText(this, "Pair first", Toast.LENGTH_SHORT).show()
            return
        }
        val intent = Intent(this, StorageNodeService::class.java).setAction(StorageNodeService.ACTION_SYNC_NOW)
        startService(intent)
        Toast.makeText(this, "Syncing…", Toast.LENGTH_SHORT).show()
    }

    private fun refreshStatus() {
        val accessLine = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            if (android.os.Environment.isExternalStorageManager()) {
                "Full storage access: granted (browsing all files)"
            } else {
                "Full storage access: not granted (browsing app folder only)"
            }
        } else {
            "Full storage access: not applicable below Android 11"
        }

        binding.statusText.text = if (storage.isPaired) {
            val runState = if (storage.nodeEnabled) "running" else "stopped"
            "Paired with device id ${storage.deviceId}\nBroker: ${storage.brokerBaseUrl}\nNode: $runState\n$accessLine"
        } else {
            "Not paired\n$accessLine"
        }
    }
}
