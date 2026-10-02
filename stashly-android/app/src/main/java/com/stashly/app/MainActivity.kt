/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

package com.stashly.app

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.content.pm.PackageManager
import android.app.AlertDialog
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.PowerManager
import android.os.StatFs
import android.provider.DocumentsContract
import android.provider.Settings
import android.view.View
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.net.toUri
import com.journeyapps.barcodescanner.CaptureActivity
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import com.stashly.app.databinding.ActivityMainBinding
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Date
import java.util.Locale

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var storage: SecureStorage
    private var pendingScopePairing: PairingResult? = null
    private var pendingScopeIsPairing = true
    private var pendingScopeTargetUserId: String? = null
    private var pairingProgressDialog: AlertDialog? = null
    private var clientRemovedDialog: AlertDialog? = null
    private var bleKeyShareServer: BleKeyShareServer? = null
    private var bleShareDialog: AlertDialog? = null

    private val blePermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { permissions ->
        val allGranted = permissions.values.all { it }
        if (allGranted) {
            checkBluetoothEnabledAndShare()
        } else {
            Toast.makeText(this, "Bluetooth permissions are required to share the key.", Toast.LENGTH_LONG).show()
        }
    }

    @SuppressLint("MissingPermission")
    private val bleEnableLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val adapter = (getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
        if (adapter != null && adapter.isEnabled) {
            startBluetoothKeyShare()
        } else {
            Toast.makeText(this, "Bluetooth was not enabled. Key share cancelled.", Toast.LENGTH_LONG).show()
        }
    }

    private val unlinkedReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == StorageNodeService.ACTION_NODE_UNLINKED) {
                if (clientRemovedDialog?.isShowing == true) {
                    storage.pendingFinalRemovalReason = intent.getStringExtra(StorageNodeService.EXTRA_UNLINK_REASON)
                } else {
                    handleConnectionRemoved()
                }
            } else if (intent?.action == StorageNodeService.ACTION_CLIENT_UNLINKED) {
                fetchLiveBrokerStatus()
                showPendingClientRemovedDialog()
            } else if (intent?.action == StorageNodeService.ACTION_CLIENT_PRESENCE) {
                fetchLiveBrokerStatus()
            }
        }
    }

    private val qrScanLauncher = registerForActivityResult(ScanContract()) { result ->
        if (result.contents != null) {
            handleScannedQr(result.contents)
        }
    }

    private val folderPickerLauncher = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        if (uri != null) {
            if (pendingScopePairing != null) handlePairingScopeFolder(uri)
        } else if (pendingScopePairing != null) {
            val pairing = pendingScopePairing
            pendingScopePairing = null
            if (pairing != null) showAccessScopeDialog(pairing)
        }
    }

    private val filePickerLauncher = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null && pendingScopePairing != null) {
            handlePairingScopeFile(uri)
        } else if (uri == null && pendingScopePairing != null) {
            val pairing = pendingScopePairing
            pendingScopePairing = null
            if (pairing != null) showAccessScopeDialog(pairing)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        storage = SecureStorage(this)
        if (storage.isPaired) {
            KeyManager(storage).getOrCreateMasterKey()
        }

        // Setup Bottom Navigation
        binding.bottomNavigation.setOnItemSelectedListener { item ->
            when (item.itemId) {
                R.id.nav_storage -> showPage(0)
                R.id.nav_connect -> showPage(1)
                R.id.nav_settings -> showPage(2)
            }
            true
        }

        // Initialize Form Inputs
        if (storage.brokerBaseUrl != null) {
            binding.inputBrokerUrl.setText(storage.brokerBaseUrl)
        }
        if (binding.inputDeviceName.text.isNullOrEmpty()) {
            binding.inputDeviceName.setText(Build.MODEL)
        }

        // Setup Actions
        binding.btnScanQr.setOnClickListener { onScanQrClicked() }
        binding.btnToggleNode.setOnClickListener { onToggleNodeClicked() }
        binding.btnSyncNow.setOnClickListener { onSyncNowClicked() }
        binding.btnSubmitPair.setOnClickListener { onPairClicked() }
        binding.btnBatteryPermission.setOnClickListener { requestIgnoreBatteryOptimizations() }
        binding.btnStoragePermission.setOnClickListener { requestFullStorageAccess() }
        binding.btnShowMasterKey.setOnClickListener { onShowMasterKeyClicked() }
        binding.btnResetNode.setOnClickListener { onResetNodeClicked() }

        // Register broadcast receiver for node unlinked events
        val filter = IntentFilter(StorageNodeService.ACTION_NODE_UNLINKED)
        filter.addAction(StorageNodeService.ACTION_CLIENT_UNLINKED)
        filter.addAction(StorageNodeService.ACTION_CLIENT_PRESENCE)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(unlinkedReceiver, filter, RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(unlinkedReceiver, filter)
        }

        // Start Foreground Service only if paired and enabled
        if (storage.isPaired && storage.nodeEnabled) {
            startForegroundService(Intent(this, StorageNodeService::class.java))
        } else {
            stopService(Intent(this, StorageNodeService::class.java))
            val manager = getSystemService(NotificationManager::class.java)
            manager?.cancel(1)
        }

        // Initial view setup
        showPage(0)
        refreshAll()
    }

    override fun onDestroy() {
        try {
            bleKeyShareServer?.stop()
            bleKeyShareServer = null
            bleShareDialog?.dismiss()
            bleShareDialog = null
        } catch (_: Exception) {}
        try {
            unregisterReceiver(unlinkedReceiver)
        } catch (_: Exception) {}
        super.onDestroy()
    }

    override fun onResume() {
        super.onResume()
        refreshAll()
        showPendingClientRemovedDialog()
    }

    private fun showPendingClientRemovedDialog() {
        val removedUserId = storage.pendingClientRemovedUserId ?: return
        if (clientRemovedDialog?.isShowing == true) return

        val removedEmail = runCatching {
            val users = JSONArray(storage.connectedUsersJson ?: "[]")
            (0 until users.length())
                .map { users.getJSONObject(it) }
                .firstOrNull { it.optString("userId") == removedUserId }
                ?.optString("email")
        }.getOrNull().orEmpty()
        val clientLabel = removedEmail.ifEmpty { "A client" }

        clientRemovedDialog = AlertDialog.Builder(this)
            .setTitle(getString(R.string.dialog_client_removed_title))
            .setMessage(getString(R.string.dialog_client_removed_msg, clientLabel))
            .setPositiveButton(getString(R.string.dialog_btn_ok)) { dialog, _ ->
                storage.pendingClientRemovedUserId = null
                dialog.dismiss()
                clientRemovedDialog = null
                if (storage.pendingFinalRemovalReason != null) {
                    storage.pendingFinalRemovalReason = null
                    handleConnectionRemoved()
                }
            }
            .setCancelable(false)
            .create()
        clientRemovedDialog?.show()
    }

    private fun handleConnectionRemoved() {
        stopService(Intent(this, StorageNodeService::class.java))
        val manager = getSystemService(NotificationManager::class.java)
        manager?.cancel(1)
        storage.clear()
        refreshAll()
        showPage(1)
        Toast.makeText(this, getString(R.string.toast_node_unlinked), Toast.LENGTH_LONG).show()

        if (!isFinishing && !isDestroyed) {
            AlertDialog.Builder(this)
                .setTitle(getString(R.string.dialog_unlinked_title))
                .setMessage(getString(R.string.dialog_unlinked_msg))
                .setPositiveButton(getString(R.string.dialog_btn_ok), null)
                .show()
        }
    }

    private fun showPage(pageIndex: Int) {
        binding.pageStorage.visibility = if (pageIndex == 0) View.VISIBLE else View.GONE
        binding.pageConnect.visibility = if (pageIndex == 1) View.VISIBLE else View.GONE
        binding.pageSettings.visibility = if (pageIndex == 2) View.VISIBLE else View.GONE

        val menuId = when (pageIndex) {
            0 -> R.id.nav_storage
            1 -> R.id.nav_connect
            else -> R.id.nav_settings
        }

        binding.bottomNavigation.menu.findItem(menuId)?.isChecked = true

        binding.topAppBar.title = when (pageIndex) {
            0 -> getString(R.string.title_storage_clients)
            1 -> getString(R.string.title_connect_new)
            else -> getString(R.string.title_settings_perms)
        }
    }

    private fun refreshAll() {
        refreshStorageMeter()
        refreshNodeStatus()
        refreshPermissions()
        fetchLiveBrokerStatus()
    }

    private fun refreshStorageMeter() {
        try {
            binding.storageScopeBadgeText.text = getString(R.string.storage_scope_all)

            val path = Environment.getDataDirectory()
            val stat = StatFs(path.path)
            val blockSize = stat.blockSizeLong
            val totalBlocks = stat.blockCountLong
            val availableBlocks = stat.availableBlocksLong

            val totalBytes = totalBlocks * blockSize
            val freeBytes = availableBlocks * blockSize
            val usedBytes = totalBytes - freeBytes

            val usedGb = usedBytes.toDouble() / (1024 * 1024 * 1024)
            val freeGb = freeBytes.toDouble() / (1024 * 1024 * 1024)
            val totalGb = totalBytes.toDouble() / (1024 * 1024 * 1024)

            val usedPercent = if (totalBytes > 0) ((usedBytes.toDouble() / totalBytes) * 100).toInt() else 0

            val usedFormatted = getString(R.string.storage_gb_format, usedGb)
            val freeFormatted = getString(R.string.storage_gb_format, freeGb)
            val totalFormatted = getString(R.string.storage_gb_format, totalGb)

            binding.storageProgressBar.progress = usedPercent
            binding.storageMainText.text = getString(R.string.storage_main_format, usedPercent, usedFormatted, totalFormatted)
            binding.storageUsedText.text = usedFormatted
            binding.storageFreeText.text = freeFormatted
            binding.storageTotalText.text = totalFormatted
        } catch (_: Exception) {
            binding.storageMainText.text = getString(R.string.storage_calc_error)
        }
    }

    private fun refreshNodeStatus() {
        val isPaired = storage.isPaired
        val isRunning = isPaired && storage.nodeEnabled

        if (!isPaired) {
            binding.nodeStatusText.text = getString(R.string.node_status_not_paired)
            binding.nodeBrokerInfoText.text = getString(R.string.node_info_not_paired)
            binding.btnToggleNode.text = getString(R.string.btn_start_node)
            binding.btnToggleNode.isEnabled = false
            binding.btnSyncNow.isEnabled = false

            binding.layoutPairedClientDetails.visibility = View.GONE
            binding.connectedClientsEmptyText.visibility = View.VISIBLE
            binding.layoutClientAccessList.removeAllViews()
        } else {
            binding.layoutPairedClientDetails.visibility = View.VISIBLE
            binding.connectedClientsEmptyText.visibility = View.GONE

            binding.nodeBrokerInfoText.text = getString(R.string.node_broker_format, storage.brokerBaseUrl ?: "")
            binding.btnToggleNode.isEnabled = true

            if (isRunning) {
                binding.nodeStatusText.text = getString(R.string.node_status_active)
                binding.btnToggleNode.text = getString(R.string.btn_stop_node)
                binding.btnSyncNow.isEnabled = true
            } else {
                binding.nodeStatusText.text = getString(R.string.node_status_stopped)
                binding.btnToggleNode.text = getString(R.string.btn_start_node)
                binding.btnSyncNow.isEnabled = false
            }

            // Top client & security specification & sync timestamp
            val now = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())
            binding.lastActiveTimestampText.text = getString(R.string.last_synced_format, now)
            binding.clientPlatformText.text = getString(R.string.client_platform_title)
            binding.clientSecurityInfoText.text = getString(R.string.client_security_title)

            // Display Connected Accounts Cards
            val cachedUsers = loadCachedConnectedUsers()
            renderConnectedAccounts(cachedUsers)
            renderClientAccessList(cachedUsers)
        }
    }

    private fun formatLastLive(timestamp: Long): String {
        return if (timestamp > 0) {
            val sdf = SimpleDateFormat("dd MMM, HH:mm:ss", Locale.getDefault())
            sdf.format(Date(timestamp))
        } else {
            getString(R.string.last_live_never)
        }
    }

    private fun formatLastSeenOrTimestamp(lastSeenIso: String?, localTimestamp: Long): String {
        if (!lastSeenIso.isNullOrEmpty()) {
            try {
                return DateTimeFormatter.ofPattern("dd MMM yyyy, hh:mm a", Locale.getDefault())
                    .withZone(ZoneId.systemDefault())
                    .format(Instant.parse(lastSeenIso))
            } catch (_: Exception) {
                return lastSeenIso
            }
        }
        return formatLastLive(localTimestamp)
    }

    private fun loadCachedConnectedUsers(): List<ConnectedUser> {
        val jsonStr = storage.connectedUsersJson ?: return emptyList()
        val list = mutableListOf<ConnectedUser>()
        try {
            val array = JSONArray(jsonStr)
            for (i in 0 until array.length()) {
                val obj = array.getJSONObject(i)
                list.add(
                    ConnectedUser(
                        userId = obj.optString("userId").ifEmpty { null },
                        email = obj.getString("email"),
                        role = obj.optString("role", "viewer"),
                        scope = AccessScope(
                            mode = obj.optString("scopeMode", "ALL"),
                            path = obj.optString("scopePath").ifEmpty { null },
                            name = obj.optString("scopeName").ifEmpty { null }
                        ),
                        sharingEnabled = obj.optBoolean("sharingEnabled", true),
                        isLive = obj.optBoolean("isLive", false),
                        lastSeenAt = obj.optString("lastSeenAt").ifEmpty { null },
                        connectedAt = obj.optString("connectedAt").ifEmpty { null }
                    )
                )
            }
        } catch (_: Exception) {}
        return list
    }

    private fun renderConnectedAccounts(users: List<ConnectedUser>) {
        binding.layoutConnectedAccountsList.removeAllViews()
        val isRunning = storage.isPaired && storage.nodeEnabled

        if (users.isEmpty()) return

        for (user in users) {
            val itemView = layoutInflater.inflate(R.layout.item_connected_user, binding.layoutConnectedAccountsList, false)
            val tvAvatar = itemView.findViewById<TextView>(R.id.userAvatarIcon)
            val tvEmail = itemView.findViewById<TextView>(R.id.userEmailText)
            val tvLiveStatus = itemView.findViewById<TextView>(R.id.userLiveStatusText)
            val tvLastActive = itemView.findViewById<TextView>(R.id.userLastActiveText)
            val tvScope = itemView.findViewById<TextView>(R.id.userAccessScopeText)

            tvAvatar.text = "👤"
            tvEmail.text = user.email
            tvScope.text = when (user.scope.mode) {
                "NONE" -> getString(R.string.user_access_scope_none)
                "CUSTOM_FILE" -> getString(
                    R.string.user_access_scope_file,
                    user.scope.name ?: user.scope.path ?: "Selected file"
                )
                "CUSTOM_FOLDER" -> getString(
                    R.string.user_access_scope_folder,
                    user.scope.name ?: user.scope.path ?: "Selected folder"
                )
                else -> getString(R.string.user_access_scope_all)
            }

            val userIsLive = user.sharingEnabled && user.isLive && isRunning
            if (!user.sharingEnabled) {
                tvLiveStatus.text = getString(R.string.user_live_status_stopped)
                tvLiveStatus.setTextColor(getColor(R.color.amber))
                tvLastActive.text = getString(R.string.user_last_active_sharing_stopped)
                tvLastActive.setTextColor(getColor(R.color.text_secondary_light))
            } else if (userIsLive) {
                tvLiveStatus.text = getString(R.string.user_live_status_live)
                tvLiveStatus.setTextColor(getColor(R.color.emerald))
                tvLastActive.text = getString(R.string.user_last_active_now)
                tvLastActive.setTextColor(getColor(R.color.emerald))
            } else if (isRunning) {
                tvLiveStatus.text = getString(R.string.user_live_status_offline)
                tvLiveStatus.setTextColor(getColor(R.color.text_secondary_light))
                val lastSeenFormatted = formatLastSeenOrTimestamp(user.lastSeenAt, storage.lastLiveTimestamp)
                tvLastActive.text = getString(R.string.user_last_active_format, lastSeenFormatted)
                tvLastActive.setTextColor(getColor(R.color.text_secondary_light))
            } else {
                tvLiveStatus.text = getString(R.string.user_live_status_paused)
                tvLiveStatus.setTextColor(getColor(R.color.amber))
                val lastSeenFormatted = formatLastSeenOrTimestamp(user.lastSeenAt, storage.lastLiveTimestamp)
                tvLastActive.text = getString(R.string.user_last_active_format, lastSeenFormatted)
                tvLastActive.setTextColor(getColor(R.color.text_secondary_light))
            }

            itemView.setOnClickListener { showClientDetailsDialog(user) }

            binding.layoutConnectedAccountsList.addView(itemView)
        }
    }

    private fun showClientDetailsDialog(user: ConnectedUser) {
        val status = when {
            !user.sharingEnabled -> getString(R.string.client_status_sharing_stopped)
            user.isLive -> getString(R.string.client_status_online)
            else -> getString(R.string.client_status_offline)
        }
        val lastSeen = if (user.isLive && user.sharingEnabled) {
            getString(R.string.client_last_seen_now)
        } else {
            getString(R.string.client_last_seen_at, formatLastSeenOrTimestamp(user.lastSeenAt, storage.lastLiveTimestamp))
        }
        val connectedSince = formatLastSeenOrTimestamp(user.connectedAt, 0L)
        val dialog = AlertDialog.Builder(this)
            .setTitle(user.email)
            .setMessage(getString(R.string.client_details_msg, status, lastSeen, connectedSince))
            .setNegativeButton(getString(R.string.dialog_btn_cancel), null)
            .setNeutralButton(getString(R.string.btn_remove_client_connection)) { _, _ ->
                showClientActionConfirmation(user, removeConnection = true)
            }
            .setPositiveButton(getString(if (user.sharingEnabled) R.string.btn_stop_sharing else R.string.btn_start_sharing)) { _, _ ->
                showClientActionConfirmation(user, removeConnection = false)
            }
            .setCancelable(true)
            .create()
        dialog.show()
    }

    private fun showClientActionConfirmation(user: ConnectedUser, removeConnection: Boolean) {
        val actionLabel = if (removeConnection) {
            getString(R.string.btn_remove_client_connection)
        } else if (user.sharingEnabled) {
            getString(R.string.btn_stop_sharing)
        } else {
            getString(R.string.btn_start_sharing)
        }
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.dialog_confirm_client_action_title))
            .setMessage(
                getString(
                    if (removeConnection) R.string.dialog_confirm_remove_client_msg
                    else R.string.dialog_confirm_sharing_msg,
                    user.email,
                    actionLabel
                )
            )
            .setNegativeButton(getString(R.string.dialog_btn_cancel), null)
            .setPositiveButton(actionLabel) { _, _ ->
                if (removeConnection) {
                    removeClientConnection(user)
                } else {
                    setClientSharing(user, !user.sharingEnabled)
                }
            }
            .setCancelable(true)
            .show()
    }

    private fun setClientSharing(user: ConnectedUser, enabled: Boolean) {
        val brokerUrl = storage.brokerBaseUrl ?: return
        val deviceToken = storage.deviceToken ?: return
        val targetUserId = user.userId ?: return
        CoroutineScope(Dispatchers.Main).launch {
            try {
                withContext(Dispatchers.IO) {
                    PairingRepository.setClientSharing(brokerUrl, deviceToken, targetUserId, enabled)
                }
                fetchLiveBrokerStatus()
                Toast.makeText(
                    this@MainActivity,
                    getString(if (enabled) R.string.toast_client_sharing_started else R.string.toast_client_sharing_stopped),
                    Toast.LENGTH_SHORT
                ).show()
            } catch (e: Exception) {
                Toast.makeText(this@MainActivity, getString(R.string.toast_access_scope_error, e.message ?: ""), Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun removeClientConnection(user: ConnectedUser) {
        val brokerUrl = storage.brokerBaseUrl ?: return
        val deviceToken = storage.deviceToken ?: return
        val targetUserId = user.userId ?: return
        CoroutineScope(Dispatchers.Main).launch {
            try {
                withContext(Dispatchers.IO) {
                    PairingRepository.removeClientAccess(brokerUrl, deviceToken, targetUserId)
                }
                fetchLiveBrokerStatus()
                Toast.makeText(this@MainActivity, getString(R.string.toast_client_connection_removed), Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                Toast.makeText(this@MainActivity, getString(R.string.toast_access_scope_error, e.message ?: ""), Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun renderClientAccessList(users: List<ConnectedUser>) {
        binding.layoutClientAccessList.removeAllViews()
        val listToRender = users

        for (user in listToRender) {
            val row = android.widget.LinearLayout(this).apply {
                orientation = android.widget.LinearLayout.VERTICAL
                setPadding(12, 10, 12, 10)
                setBackgroundColor(getColor(R.color.surface_subtle_light))
                layoutParams = android.widget.LinearLayout.LayoutParams(
                    android.widget.LinearLayout.LayoutParams.MATCH_PARENT,
                    android.widget.LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply { bottomMargin = 8 }
            }

            row.addView(android.widget.TextView(this).apply {
                text = user.email
                setTextColor(getColor(R.color.text_primary_light))
                textSize = 13f
                setTypeface(typeface, android.graphics.Typeface.BOLD)
            })

            row.addView(android.widget.TextView(this).apply {
                text = when (user.scope.mode) {
                    "NONE" -> getString(R.string.user_access_scope_none)
                    "CUSTOM_FILE" -> getString(R.string.user_access_scope_file, user.scope.name ?: user.scope.path ?: "Selected file")
                    "CUSTOM_FOLDER" -> getString(R.string.user_access_scope_folder, user.scope.name ?: user.scope.path ?: "Selected folder")
                    else -> getString(R.string.user_access_scope_all)
                }
                setTextColor(getColor(R.color.primary))
                textSize = 12f
                setPadding(0, 4, 0, 0)
            })

            val editToken = storage.deviceToken
            if (editToken != null) {
                row.addView(android.widget.Button(this).apply {
                    text = getString(R.string.btn_change_client_access)
                    setOnClickListener {
                        pendingScopeIsPairing = false
                        showAccessScopeDialog(
                            PairingResult(
                                deviceId = storage.deviceId ?: return@setOnClickListener,
                                deviceToken = editToken,
                                userId = user.userId,
                                role = if (user.userId == storage.ownerUserId) "owner" else "viewer",
                                userEmail = user.email
                            )
                        )
                    }
                })
            } else {
                row.addView(android.widget.TextView(this).apply {
                    text = getString(R.string.client_access_managed)
                    setTextColor(getColor(R.color.text_secondary_light))
                    textSize = 11f
                    setPadding(0, 4, 0, 0)
                })
            }
            binding.layoutClientAccessList.addView(row)
        }
    }

    private fun fetchLiveBrokerStatus() {
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
                    if (selfInfo.users.isNotEmpty() && storage.userEmail.isNullOrEmpty()) {
                        storage.userEmail = selfInfo.users.first().email
                    }
                    selfInfo.users.firstOrNull { it.userId == storage.currentUserId || it.email == storage.userEmail }?.let { current ->
                        if (current.role == "owner" && current.userId != null) {
                            storage.ownerUserId = current.userId
                            storage.ownerDeviceToken = storage.deviceToken
                        }
                    }
                    renderConnectedAccounts(selfInfo.users)
                    renderClientAccessList(selfInfo.users)
                    if (selfInfo.isLive) {
                        storage.isLive = true
                    }
                    val now = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())
                    binding.lastActiveTimestampText.text = getString(R.string.last_synced_format, now)
                }
            } catch (e: Exception) {
                val errorMsg = e.message.orEmpty()
                if (errorMsg.contains("401") || errorMsg.contains("404") || errorMsg.contains("Device not found", ignoreCase = true) || errorMsg.contains("Invalid", ignoreCase = true)) {
                    withContext(Dispatchers.Main) {
                        handleConnectionRemoved()
                    }
                }
            }
        }
    }

    private fun refreshPermissions() {
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        val ignoringBattery = pm.isIgnoringBatteryOptimizations(packageName)
        binding.batteryStatusText.text = getString(
            if (ignoringBattery) R.string.battery_status_allowed else R.string.battery_status_active
        )
        binding.btnBatteryPermission.isEnabled = !ignoringBattery
        if (ignoringBattery) binding.btnBatteryPermission.text = getString(R.string.btn_granted)

        val hasAllFilesAccess = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Environment.isExternalStorageManager()
        } else {
            true
        }

        binding.storageScopeStatusText.text = getString(
            if (hasAllFilesAccess) R.string.device_file_access_allowed else R.string.device_file_access_not_allowed
        )
        binding.storagePermissionStatusText.text = getString(
            if (hasAllFilesAccess) R.string.storage_full_access_desc else R.string.storage_limited_access_desc
        )

        binding.btnStoragePermission.isEnabled = !hasAllFilesAccess
        if (hasAllFilesAccess) {
            binding.btnStoragePermission.text = getString(R.string.btn_granted)
        } else {
            binding.btnStoragePermission.text = getString(R.string.btn_all_storage)
        }
    }

    private data class FolderSelection(val virtualPath: String, val displayName: String, val localPath: String)

    private fun getFolderSelection(uri: Uri): FolderSelection {
        val docId = try {
            DocumentsContract.getTreeDocumentId(uri)
        } catch (_: Exception) {
            uri.lastPathSegment ?: ""
        }

        val split = docId.split(":")
        val type = split.getOrNull(0) ?: "primary"
        val relativePath = if (split.size > 1) split[1].trim('/') else ""
        val displayName = relativePath.substringAfterLast('/').ifEmpty { type }
        val virtualPath = if (relativePath.isEmpty()) "/" else "/$relativePath"
        val localPath = if (type.equals("primary", ignoreCase = true)) {
            File(Environment.getExternalStorageDirectory(), relativePath).absolutePath
        } else {
            "/storage/$type/$relativePath"
        }
        return FolderSelection(virtualPath, displayName, localPath)
    }

    private fun handlePairingScopeFolder(uri: Uri) {
        val pairing = pendingScopePairing ?: return
        try {
            contentResolver.takePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            )
        } catch (_: Exception) {}
        val selection = getFolderSelection(uri)
        savePairingScope(pairing, AccessScope("CUSTOM_FOLDER", selection.virtualPath, selection.displayName))
    }

    private fun handlePairingScopeFile(uri: Uri) {
        val pairing = pendingScopePairing ?: return
        try {
            contentResolver.takePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION
            )
        } catch (_: Exception) {}
        val documentId = runCatching { DocumentsContract.getDocumentId(uri) }.getOrNull() ?: uri.lastPathSegment.orEmpty()
        val split = documentId.split(":")
        val relativePath = split.getOrNull(1)?.trim('/') ?: documentId.trim('/')
        val virtualPath = if (relativePath.isEmpty()) "/" else "/$relativePath"
        val displayName = relativePath.substringAfterLast('/').ifEmpty { "Selected file" }
        savePairingScope(pairing, AccessScope("CUSTOM_FILE", virtualPath, displayName))
    }

    private fun showAccessScopeDialog(pairing: PairingResult) {
        pendingScopeTargetUserId = pairing.userId
        val optionLayout = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            setPadding(32, 8, 32, 0)
        }
        lateinit var dialog: AlertDialog
        fun addOption(label: String, action: () -> Unit) {
            optionLayout.addView(android.widget.Button(this).apply {
                text = label
                setOnClickListener {
                    dialog.dismiss()
                    action()
                }
            })
        }
        addOption(getString(R.string.scope_option_all)) { savePairingScope(pairing, AccessScope()) }
        addOption(getString(R.string.scope_option_folder)) { beginFolderScopePicker(pairing) }
        addOption(getString(R.string.scope_option_file)) { beginFileScopePicker(pairing) }

        dialog = AlertDialog.Builder(this)
            .setTitle(getString(R.string.dialog_access_scope_title))
            .setMessage(getString(R.string.dialog_access_scope_msg, pairing.userEmail ?: "this client"))
            .setView(optionLayout)
            .setNegativeButton(getString(R.string.dialog_btn_cancel)) { _, _ ->
                pendingScopePairing = null
                if (pendingScopeIsPairing) storage.nodeEnabled = false
            }
            .setCancelable(false)
            .create()
        dialog.show()
    }

    private fun beginFolderScopePicker(pairing: PairingResult) {
        pendingScopePairing = pairing
        try {
            folderPickerLauncher.launch(null)
        } catch (e: Exception) {
            pendingScopePairing = null
            Toast.makeText(this, getString(R.string.toast_folder_picker_error, e.message ?: ""), Toast.LENGTH_SHORT).show()
        }
    }

    private fun beginFileScopePicker(pairing: PairingResult) {
        pendingScopePairing = pairing
        try {
            filePickerLauncher.launch(arrayOf("*/*"))
        } catch (e: Exception) {
            pendingScopePairing = null
            Toast.makeText(this, getString(R.string.toast_folder_picker_error, e.message ?: ""), Toast.LENGTH_SHORT).show()
        }
    }

    private fun savePairingScope(pairing: PairingResult, scope: AccessScope) {
        val brokerUrl = storage.brokerBaseUrl ?: return
        val deviceToken = pairing.deviceToken
        val isPairing = pendingScopeIsPairing
        val targetUserId = pendingScopeTargetUserId
        pendingScopePairing = null

        CoroutineScope(Dispatchers.Main).launch {
            try {
                withContext(Dispatchers.IO) {
                    PairingRepository.updateAccessScope(brokerUrl, deviceToken, scope, targetUserId)
                }
                storage.nodeEnabled = true
                startForegroundService(Intent(this@MainActivity, StorageNodeService::class.java))
                Toast.makeText(
                    this@MainActivity,
                    getString(if (isPairing) R.string.toast_paired_success else R.string.toast_access_scope_saved),
                    Toast.LENGTH_LONG
                ).show()
                if (isPairing) {
                    binding.inputPairingToken.setText("")
                    showPage(0)
                }
                refreshAll()
            } catch (e: Exception) {
                Toast.makeText(this@MainActivity, getString(R.string.toast_access_scope_error, e.message ?: ""), Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun onToggleNodeClicked() {
        if (!storage.isPaired) {
            Toast.makeText(this, getString(R.string.toast_pair_first), Toast.LENGTH_SHORT).show()
            return
        }

        if (storage.nodeEnabled) {
            storage.nodeEnabled = false
            stopService(Intent(this, StorageNodeService::class.java))
            Toast.makeText(this, getString(R.string.toast_node_stopped), Toast.LENGTH_SHORT).show()
        } else {
            storage.nodeEnabled = true
            startForegroundService(Intent(this, StorageNodeService::class.java))
            Toast.makeText(this, getString(R.string.toast_node_started), Toast.LENGTH_SHORT).show()
        }
        refreshNodeStatus()
    }

    private fun onSyncNowClicked() {
        if (!storage.isPaired) return
        Toast.makeText(this, getString(R.string.toast_syncing), Toast.LENGTH_SHORT).show()
        startForegroundService(
            Intent(this, StorageNodeService::class.java).setAction(StorageNodeService.ACTION_SYNC_NOW)
        )
        Toast.makeText(this, getString(R.string.toast_sync_success), Toast.LENGTH_SHORT).show()
        refreshNodeStatus()
    }

    private fun onScanQrClicked() {
        val options = ScanOptions().apply {
            setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            setPrompt(getString(R.string.qr_scan_prompt))
            setCameraId(0)
            setBeepEnabled(false)
            setBarcodeImageEnabled(false)
            setOrientationLocked(false)
            setCaptureActivity(PortraitCaptureActivity::class.java)
        }
        qrScanLauncher.launch(options)
    }

    private fun handleScannedQr(rawText: String) {
        val text = rawText.trim()
        if (binding.inputDeviceName.text.isNullOrEmpty()) {
            binding.inputDeviceName.setText(Build.MODEL)
        }
        try {
            // Case 1: Structured JSON payload {"type":"stashly_pair","brokerUrl":"...","token":"..."}
            if (text.startsWith("{") && text.endsWith("}")) {
                val json = JSONObject(text)
                val url = json.optString("brokerUrl", "").trim()
                val token = json.optString("token", "").trim()
                if (url.isNotEmpty()) binding.inputBrokerUrl.setText(url)
                if (token.isNotEmpty()) binding.inputPairingToken.setText(token)
                Toast.makeText(this, getString(R.string.toast_qr_autopair), Toast.LENGTH_SHORT).show()
                onPairClicked()
                return
            }

            // Case 2: URL with query parameters: stashly://pair?url=...&token=...
            if (text.contains("token=") || text.startsWith("http://") || text.startsWith("https://")) {
                val uri = text.toUri()
                val token = uri.getQueryParameter("token") ?: ""
                val url = uri.getQueryParameter("url") ?: if (text.startsWith("http")) text else ""
                if (url.isNotEmpty()) binding.inputBrokerUrl.setText(url)
                if (token.isNotEmpty()) binding.inputPairingToken.setText(token)
                Toast.makeText(this, getString(R.string.toast_qr_autopair), Toast.LENGTH_SHORT).show()
                onPairClicked()
                return
            }

            // Case 3: Raw pairing code only (8-chars)
            binding.inputPairingToken.setText(text.uppercase(Locale.ROOT))
            Toast.makeText(this, getString(R.string.toast_qr_code_loaded, text), Toast.LENGTH_SHORT).show()
            if (!binding.inputBrokerUrl.text.isNullOrEmpty()) {
                onPairClicked()
            }
        } catch (e: Exception) {
            Toast.makeText(this, getString(R.string.toast_qr_parse_error, e.message ?: ""), Toast.LENGTH_LONG).show()
        }
    }

    private fun onPairClicked() {
        if (binding.inputDeviceName.text.isNullOrEmpty()) {
            binding.inputDeviceName.setText(Build.MODEL)
        }
        var brokerUrl = binding.inputBrokerUrl.text?.toString()?.trim().orEmpty()
        val deviceName = binding.inputDeviceName.text?.toString()?.trim().orEmpty()
        val pairingToken = binding.inputPairingToken.text?.toString()?.trim()?.uppercase(Locale.ROOT).orEmpty()

        if (brokerUrl.isEmpty() || deviceName.isEmpty() || pairingToken.isEmpty()) {
            Toast.makeText(this, getString(R.string.toast_fill_fields), Toast.LENGTH_SHORT).show()
            return
        }

        if (!brokerUrl.startsWith("http://", ignoreCase = true) && !brokerUrl.startsWith("https://", ignoreCase = true)) {
            brokerUrl = "http://$brokerUrl"
        }
        brokerUrl = brokerUrl.trimEnd('/')

        binding.btnSubmitPair.isEnabled = false
        binding.btnSubmitPair.text = getString(R.string.btn_pairing_progress)
        pairingProgressDialog = AlertDialog.Builder(this)
            .setTitle(getString(R.string.dialog_pairing_title))
            .setMessage(getString(R.string.dialog_pairing_msg))
            .setView(ProgressBar(this))
            .setCancelable(false)
            .show()

        val targetUrl = brokerUrl
        CoroutineScope(Dispatchers.Main).launch {
            try {
                val deviceInfo = readDeviceInfo()
                val result = withContext(Dispatchers.IO) {
                    PairingRepository.pair(
                        targetUrl,
                        pairingToken,
                        deviceName,
                        existingDeviceId = storage.deviceId,
                        modelName = deviceInfo.modelName,
                        modelNumber = deviceInfo.modelNumber,
                        androidVersion = deviceInfo.androidVersion,
                        osVersion = deviceInfo.osVersion,
                        appVersion = deviceInfo.appVersion,
                        batteryLevel = deviceInfo.batteryLevel,
                        storageTotalMb = deviceInfo.storageTotalMb,
                        storageFreeMb = deviceInfo.storageFreeMb
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
                // Create the node key immediately after pairing so it is available
                // before the access-scope picker and the first file sync.
                KeyManager(storage).getOrCreateMasterKey()

                stopService(Intent(this@MainActivity, StorageNodeService::class.java))
                storage.nodeEnabled = false
                pairingProgressDialog?.dismiss()
                pairingProgressDialog = null
                pendingScopeIsPairing = true
                showAccessScopeDialog(result)
            } catch (e: Exception) {
                pairingProgressDialog?.dismiss()
                pairingProgressDialog = null
                val msg = if (e.message?.contains("Failed to connect", ignoreCase = true) == true) {
                    getString(R.string.toast_pairing_error_network, targetUrl)
                } else {
                    getString(R.string.toast_pairing_error_general, e.message ?: "")
                }
                Toast.makeText(this@MainActivity, msg, Toast.LENGTH_LONG).show()
            } finally {
                binding.btnSubmitPair.isEnabled = true
                binding.btnSubmitPair.text = getString(R.string.btn_pair_submit)
            }
        }
    }

    private data class DeviceInfo(
        val modelName: String,
        val modelNumber: String,
        val androidVersion: String,
        val osVersion: String,
        val appVersion: String,
        val batteryLevel: Int?,
        val storageTotalMb: Int?,
        val storageFreeMb: Int?
    )

    private fun readDeviceInfo(): DeviceInfo {
        val stat = StatFs(Environment.getExternalStorageDirectory().path)
        fun toMb(value: Long): Int? = (value / (1024L * 1024L)).coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
        val batteryManager = getSystemService(BATTERY_SERVICE) as android.os.BatteryManager
        val battery = batteryManager.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY)
            .takeIf { it in 0..100 }
        return DeviceInfo(
            modelName = "${Build.MANUFACTURER} ${Build.MODEL}".trim(),
            modelNumber = Build.DEVICE,
            androidVersion = Build.VERSION.RELEASE ?: "Unknown",
            osVersion = Build.VERSION.RELEASE ?: "Unknown",
            appVersion = packageManager.getPackageInfo(packageName, 0).versionName ?: "Unknown",
            batteryLevel = battery,
            storageTotalMb = toMb(stat.totalBytes),
            storageFreeMb = toMb(stat.availableBytes)
        )
    }

    @SuppressLint("BatteryLife")
    private fun requestIgnoreBatteryOptimizations() {
        val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
            data = "package:$packageName".toUri()
        }
        startActivity(intent)
    }

    private fun requestFullStorageAccess() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION).apply {
                data = "package:$packageName".toUri()
            }
            startActivity(intent)
        } else {
            Toast.makeText(this, getString(R.string.toast_storage_default), Toast.LENGTH_SHORT).show()
        }
    }

    private fun onShowMasterKeyClicked() {
        val key = storage.masterKeyBase64
        if (key == null) {
            Toast.makeText(this, getString(R.string.toast_no_key), Toast.LENGTH_SHORT).show()
            return
        }

        val options = arrayOf(
            "\uD83D\uDCCB  Copy to Clipboard",
            "\uD83D\uDCF6  Share via Bluetooth",
            "\uD83D\uDC41  View Key"
        )

        AlertDialog.Builder(this)
            .setTitle(getString(R.string.dialog_master_key_title))
            .setItems(options) { _, which ->
                when (which) {
                    0 -> {
                        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                        clipboard.setPrimaryClip(ClipData.newPlainText("Stashly master key", key))
                        Toast.makeText(this, getString(R.string.toast_master_key_copied), Toast.LENGTH_SHORT).show()
                    }
                    1 -> requestBluetoothPermissionsAndShare()
                    2 -> {
                        AlertDialog.Builder(this)
                            .setTitle("Master Key")
                            .setMessage(getString(R.string.dialog_master_key_msg, key))
                            .setNeutralButton(getString(R.string.dialog_btn_copy_key)) { _, _ ->
                                val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                                clipboard.setPrimaryClip(ClipData.newPlainText("Stashly master key", key))
                                Toast.makeText(this, getString(R.string.toast_master_key_copied), Toast.LENGTH_SHORT).show()
                            }
                            .setPositiveButton(getString(R.string.dialog_btn_ok), null)
                            .show()
                    }
                }
            }
            .setNegativeButton(getString(R.string.dialog_btn_cancel), null)
            .show()
    }

    @SuppressLint("MissingPermission")
    private fun requestBluetoothPermissionsAndShare() {
        // Step 1: Check runtime permissions (Android 12+)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val needed = mutableListOf<String>()
            if (checkSelfPermission(Manifest.permission.BLUETOOTH_ADVERTISE) != PackageManager.PERMISSION_GRANTED) {
                needed.add(Manifest.permission.BLUETOOTH_ADVERTISE)
            }
            if (checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
                needed.add(Manifest.permission.BLUETOOTH_CONNECT)
            }
            if (needed.isNotEmpty()) {
                blePermissionLauncher.launch(needed.toTypedArray())
                return
            }
        }
        // Step 2: Check if Bluetooth is enabled
        checkBluetoothEnabledAndShare()
    }

    @SuppressLint("MissingPermission")
    private fun checkBluetoothEnabledAndShare() {
        val bluetoothManager = getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        val adapter = bluetoothManager?.adapter

        if (adapter == null) {
            Toast.makeText(this, "Bluetooth is not available on this device.", Toast.LENGTH_LONG).show()
            return
        }

        if (!adapter.isEnabled) {
            // Show dialog prompting user to enable Bluetooth
            AlertDialog.Builder(this)
                .setTitle("Bluetooth Required")
                .setMessage(
                    "Bluetooth must be turned on to share your master key.\n\n" +
                    "The web browser needs to discover this device via Bluetooth " +
                    "to securely receive the encryption key."
                )
                .setPositiveButton("Turn On Bluetooth") { _, _ ->
                    @Suppress("DEPRECATION")
                    val enableBtIntent = Intent(android.bluetooth.BluetoothAdapter.ACTION_REQUEST_ENABLE)
                    bleEnableLauncher.launch(enableBtIntent)
                }
                .setNegativeButton(getString(R.string.dialog_btn_cancel), null)
                .show()
            return
        }

        // Bluetooth is on, start sharing
        startBluetoothKeyShare()
    }

    @SuppressLint("MissingPermission")
    private fun startBluetoothKeyShare() {
        val adapter = (getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
        if (adapter == null) {
            Toast.makeText(this, "Bluetooth is not available on this device.", Toast.LENGTH_LONG).show()
            return
        }
        if (!adapter.isEnabled) {
            // Bluetooth may have been disabled while the enable request was open.
            // Re-open the confirmation flow instead of starting a dead share session.
            checkBluetoothEnabledAndShare()
            return
        }

        val key = storage.masterKeyBase64
        if (key == null) {
            Toast.makeText(this, getString(R.string.toast_no_key), Toast.LENGTH_SHORT).show()
            return
        }

        // Clean up any previous session
        bleKeyShareServer?.stop()

        bleKeyShareServer = BleKeyShareServer(
            context = this,
            masterKeyBase64 = key,
            onPinGenerated = { pin ->
                runOnUiThread {
                    bleShareDialog?.dismiss()
                    bleShareDialog = AlertDialog.Builder(this)
                        .setTitle("Confirm Pairing PIN")
                        .setMessage(
                            "A web client has connected.\n\n" +
                            "Verify this PIN matches the one shown in the browser:\n\n" +
                            "       $pin\n\n" +
                            "If the PINs match, the master key will be shared securely."
                        )
                        .setCancelable(false)
                        .setNegativeButton("Cancel") { _, _ ->
                            bleKeyShareServer?.stop()
                            bleKeyShareServer = null
                            Toast.makeText(this, "Bluetooth key share cancelled.", Toast.LENGTH_SHORT).show()
                        }
                        .create()
                    bleShareDialog?.show()
                }
            },
            onClientConnected = { clientName ->
                runOnUiThread {
                    bleShareDialog?.dismiss()
                    bleShareDialog = AlertDialog.Builder(this)
                        .setTitle("Client Connected")
                        .setMessage("$clientName connected.\nPerforming secure key exchange...")
                        .setCancelable(false)
                        .create()
                    bleShareDialog?.show()
                }
            },
            onTransferComplete = {
                runOnUiThread {
                    bleShareDialog?.dismiss()
                    bleShareDialog = null
                    bleKeyShareServer?.stop()
                    bleKeyShareServer = null
                    AlertDialog.Builder(this)
                        .setTitle("Key Shared Successfully")
                        .setMessage(
                            "Your master key has been securely transferred " +
                            "to the connected web client via Bluetooth.\n\n" +
                            "The web browser can now decrypt your vault files."
                        )
                        .setPositiveButton(getString(R.string.dialog_btn_ok), null)
                        .show()
                }
            },
            onError = { errorMsg ->
                runOnUiThread {
                    bleShareDialog?.dismiss()
                    bleShareDialog = null
                    bleKeyShareServer?.stop()
                    bleKeyShareServer = null
                    Toast.makeText(this, "Bluetooth error: $errorMsg", Toast.LENGTH_LONG).show()
                }
            }
        )

        bleKeyShareServer!!.start()

        // Show waiting dialog
        bleShareDialog = AlertDialog.Builder(this)
            .setTitle("Waiting for Connection")
            .setMessage(
                "Your device is now advertising via Bluetooth.\n\n" +
                "On the web dashboard, open the Master Key drawer " +
                "and tap \"Bluetooth Transfer\", then select this device.\n\n" +
                "The connection will timeout in 2 minutes."
            )
            .setCancelable(false)
            .setNegativeButton("Cancel") { _, _ ->
                bleKeyShareServer?.stop()
                bleKeyShareServer = null
                Toast.makeText(this, "Bluetooth key share cancelled.", Toast.LENGTH_SHORT).show()
            }
            .create()
        bleShareDialog?.show()
    }

    private fun onResetNodeClicked() {
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.dialog_reset_title))
            .setMessage(getString(R.string.dialog_reset_msg))
            .setPositiveButton(getString(R.string.dialog_btn_reset)) { _, _ ->
                val brokerUrl = storage.brokerBaseUrl
                val deviceToken = storage.deviceToken
                if (brokerUrl.isNullOrEmpty() || deviceToken.isNullOrEmpty()) {
                    finishLocalNodeReset()
                    return@setPositiveButton
                }
                CoroutineScope(Dispatchers.Main).launch {
                    try {
                        withContext(Dispatchers.IO) {
                            PairingRepository.resetNode(brokerUrl, deviceToken)
                        }
                        finishLocalNodeReset()
                    } catch (e: Exception) {
                        Toast.makeText(
                            this@MainActivity,
                            getString(R.string.toast_reset_error, e.message ?: ""),
                            Toast.LENGTH_LONG
                        ).show()
                    }
                }
            }
            .setNegativeButton(getString(R.string.dialog_btn_cancel), null)
            .show()
    }

    private fun finishLocalNodeReset() {
        stopService(Intent(this, StorageNodeService::class.java))
        FileVault(this, KeyManager(storage), storage).clearVaultCache()
        storage.clear()
        Toast.makeText(this, getString(R.string.toast_node_cleared), Toast.LENGTH_SHORT).show()
        refreshAll()
        showPage(1)
    }
}

/**
 * Custom CaptureActivity for ZXing barcode scanner that adapts to the
 * mobile device's orientation (portrait / sensor) rather than default landscape.
 */
class PortraitCaptureActivity : CaptureActivity()
