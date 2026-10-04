/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

package com.stashly.app

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.ViewModelProvider
import androidx.appcompat.app.AppCompatActivity
import com.journeyapps.barcodescanner.CaptureActivity
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import com.stashly.app.databinding.ActivityMainBinding
import java.util.Locale

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var storage: SecureStorage
    private lateinit var vm: MainViewModel

    // Controllers (initialized in onCreate after storage is ready)
    private lateinit var nodeCtrl: NodeController
    private lateinit var accountsCtrl: ConnectedAccountsController
    private lateinit var pairingCtrl: PairingFlowController
    private val btCoordinator by lazy { BluetoothPairingCoordinator(this) }

    private var pairingProgressDialog: AlertDialog? = null
    private var clientRemovedDialog: AlertDialog? = null
    private var bleKeyShareServer: BleKeyShareServer? = null
    private var bleShareDialog: AlertDialog? = null

    // ── ActivityResultLaunchers (must stay as Activity fields) ──

    private val blePermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { permissions ->
        if (permissions.values.all { it }) {
            checkBluetoothAndShare()
        } else {
            Toast.makeText(this, "Bluetooth permissions are required to share the key.", Toast.LENGTH_LONG).show()
        }
    }

    @SuppressLint("MissingPermission")
    private val bleEnableLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        if (btCoordinator.checkBluetoothState() == BluetoothPairingCoordinator.BluetoothState.READY) {
            onStartBluetoothKeyShare()
        } else {
            Toast.makeText(this, "Bluetooth was not enabled. Key share cancelled.", Toast.LENGTH_LONG).show()
        }
    }

    private val qrScanLauncher = registerForActivityResult(ScanContract()) { result ->
        if (result.contents != null) handleScannedQr(result.contents)
    }

    private val folderPickerLauncher = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        val pairing = vm.pendingScopePairing
        if (uri != null && pairing != null) {
            val scope = pairingCtrl.parseFolderScope(uri, contentResolver)
            if (scope != null) doSavePairingScope(pairing, scope)
        } else if (uri == null && pairing != null) {
            vm.pendingScopePairing = null
            showAccessScopeDialog(pairing)
        }
    }

    private val filePickerLauncher = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        val pairing = vm.pendingScopePairing
        if (uri != null && pairing != null) {
            val scope = pairingCtrl.parseFileScope(uri, contentResolver)
            if (scope != null) doSavePairingScope(pairing, scope)
        } else if (uri == null && pairing != null) {
            vm.pendingScopePairing = null
            showAccessScopeDialog(pairing)
        }
    }

    private val unlinkedReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            when (intent?.action) {
                StorageNodeService.ACTION_NODE_UNLINKED -> {
                    if (clientRemovedDialog?.isShowing == true) {
                        storage.pendingFinalRemovalReason = intent.getStringExtra(StorageNodeService.EXTRA_UNLINK_REASON)
                    } else handleConnectionRemoved()
                }
                StorageNodeService.ACTION_CLIENT_UNLINKED -> { fetchLiveBrokerStatus(); showPendingClientRemovedDialog() }
                StorageNodeService.ACTION_CLIENT_PRESENCE -> fetchLiveBrokerStatus()
            }
        }
    }

    // ── Lifecycle ──

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        storage = SecureStorage(this)
        vm = ViewModelProvider(this)[MainViewModel::class.java]
        nodeCtrl = NodeController(storage, vm)
        accountsCtrl = ConnectedAccountsController(storage, vm)
        pairingCtrl = PairingFlowController(storage, vm)

        nodeCtrl.scheduleTrashCleanup(applicationContext)
        if (storage.isPaired) KeyManager(storage).getOrCreateMasterKey()

        binding.bottomNavigation.setOnItemSelectedListener { item ->
            when (item.itemId) { R.id.nav_storage -> showPage(0); R.id.nav_connect -> showPage(1); R.id.nav_settings -> showPage(2) }; true
        }
        if (storage.brokerBaseUrl != null) binding.inputBrokerUrl.setText(storage.brokerBaseUrl)
        if (binding.inputDeviceName.text.isNullOrEmpty()) binding.inputDeviceName.setText(Build.MODEL)

        binding.btnScanQr.setOnClickListener { onScanQrClicked() }
        binding.btnToggleNode.setOnClickListener {
            nodeCtrl.toggleNode(
                onStartService = { startForegroundService(Intent(this, StorageNodeService::class.java)) },
                onStopService = { stopService(Intent(this, StorageNodeService::class.java)) },
                onNotPaired = { Toast.makeText(this, getString(R.string.toast_pair_first), Toast.LENGTH_SHORT).show() },
                onStatusChange = { started ->
                    Toast.makeText(this, getString(if (started) R.string.toast_node_started else R.string.toast_node_stopped), Toast.LENGTH_SHORT).show()
                    applyNodeStatus()
                }
            )
        }
        binding.btnSyncNow.setOnClickListener {
            if (nodeCtrl.syncNow {
                    startForegroundService(Intent(this, StorageNodeService::class.java).setAction(StorageNodeService.ACTION_SYNC_NOW))
                }) {
                Toast.makeText(this, getString(R.string.toast_syncing), Toast.LENGTH_SHORT).show()
                Toast.makeText(this, getString(R.string.toast_sync_success), Toast.LENGTH_SHORT).show()
                applyNodeStatus()
            }
        }
        binding.btnSubmitPair.setOnClickListener { onPairClicked() }
        binding.btnEditSystemPermissions.setOnClickListener { startActivity(Intent(this, SystemPermissionsActivity::class.java)) }
        binding.btnManageClientStorageAccess.setOnClickListener { startActivity(Intent(this, ClientStorageAccessActivity::class.java)) }
        binding.btnShowMasterKey.setOnClickListener { onShowMasterKeyClicked() }
        binding.btnRecycleBinCard.setOnClickListener { startActivity(Intent(this, RecycleBinActivity::class.java)) }
        binding.btnResetNode.setOnClickListener { onResetNodeClicked() }

        val filter = IntentFilter(StorageNodeService.ACTION_NODE_UNLINKED).apply {
            addAction(StorageNodeService.ACTION_CLIENT_UNLINKED)
            addAction(StorageNodeService.ACTION_CLIENT_PRESENCE)
        }
        androidx.core.content.ContextCompat.registerReceiver(this, unlinkedReceiver, filter, androidx.core.content.ContextCompat.RECEIVER_NOT_EXPORTED)

        if (storage.isPaired && storage.nodeEnabled) startForegroundService(Intent(this, StorageNodeService::class.java))
        else { stopService(Intent(this, StorageNodeService::class.java)); getSystemService(NotificationManager::class.java)?.cancel(1) }

        showPage(0); refreshAll()
    }

    override fun onDestroy() {
        try { bleKeyShareServer?.stop(); bleKeyShareServer = null; btCoordinator.stop(); bleShareDialog?.dismiss(); bleShareDialog = null } catch (_: Exception) {}
        try { unregisterReceiver(unlinkedReceiver) } catch (_: Exception) {}
        super.onDestroy()
    }

    override fun onResume() { super.onResume(); refreshAll(); StashlyWidgetProvider.updateAll(this); showPendingClientRemovedDialog() }

    // ── Navigation & refresh ──

    private fun showPage(pageIndex: Int) {
        vm.selectedPage = pageIndex
        binding.pageStorage.visibility = if (pageIndex == 0) View.VISIBLE else View.GONE
        binding.pageConnect.visibility = if (pageIndex == 1) View.VISIBLE else View.GONE
        binding.pageSettings.visibility = if (pageIndex == 2) View.VISIBLE else View.GONE
        binding.bottomNavigation.menu.findItem(when (pageIndex) { 0 -> R.id.nav_storage; 1 -> R.id.nav_connect; else -> R.id.nav_settings })?.isChecked = true
        binding.topAppBar.title = getString(when (pageIndex) { 0 -> R.string.title_storage_clients; 1 -> R.string.title_connect_new; else -> R.string.title_settings_perms })
    }

    private fun refreshAll() {
        nodeCtrl.refreshStorageMeter(); applyStorageMeter()
        nodeCtrl.refreshNodeStatus(); applyNodeStatus()
        fetchLiveBrokerStatus()
    }

    // ── Applying ViewModel state to views ──

    private fun applyStorageMeter() {
        val data = vm.storageMeterData
        binding.storageScopeBadgeText.text = getString(R.string.storage_scope_all)
        if (data != null) {
            val usedF = getString(R.string.storage_gb_format, data.usedGb)
            val freeF = getString(R.string.storage_gb_format, data.freeGb)
            val totalF = getString(R.string.storage_gb_format, data.totalGb)
            binding.storageProgressBar.progress = data.usedPercent
            binding.storageMainText.text = getString(R.string.storage_main_format, data.usedPercent, usedF, totalF)
            binding.storageUsedText.text = usedF; binding.storageFreeText.text = freeF; binding.storageTotalText.text = totalF
        } else {
            binding.storageMainText.text = getString(R.string.storage_calc_error)
        }
    }

    private fun applyNodeStatus() {
        nodeCtrl.refreshNodeStatus()
        if (!vm.nodePaired) {
            binding.nodeStatusText.text = getString(R.string.node_status_not_paired)
            binding.nodeBrokerInfoText.text = getString(R.string.node_info_not_paired)
            binding.btnToggleNode.text = getString(R.string.btn_start_node); binding.btnToggleNode.isEnabled = false; binding.btnSyncNow.isEnabled = false
            binding.layoutPairedClientDetails.visibility = View.GONE; binding.connectedClientsEmptyText.visibility = View.VISIBLE
        } else {
            binding.layoutPairedClientDetails.visibility = View.VISIBLE; binding.connectedClientsEmptyText.visibility = View.GONE
            binding.nodeBrokerInfoText.text = getString(R.string.node_broker_format, vm.brokerUrl ?: "")
            binding.btnToggleNode.isEnabled = true
            if (vm.nodeRunning) {
                binding.nodeStatusText.text = getString(R.string.node_status_active); binding.btnToggleNode.text = getString(R.string.btn_stop_node); binding.btnSyncNow.isEnabled = true
            } else {
                binding.nodeStatusText.text = getString(R.string.node_status_stopped); binding.btnToggleNode.text = getString(R.string.btn_start_node); binding.btnSyncNow.isEnabled = false
            }
            binding.lastActiveTimestampText.text = getString(R.string.last_synced_format, vm.lastSyncTime)
            binding.clientPlatformText.text = getString(R.string.client_platform_title)
            binding.clientSecurityInfoText.text = getString(R.string.client_security_title)
            renderConnectedAccounts(vm.connectedUsers)
        }
    }

    private fun renderConnectedAccounts(users: List<ConnectedUser>) {
        binding.layoutConnectedAccountsList.removeAllViews()
        if (users.isEmpty()) return
        for (user in users) {
            val itemView = layoutInflater.inflate(R.layout.item_connected_user, binding.layoutConnectedAccountsList, false)
            itemView.findViewById<TextView>(R.id.userAvatarIcon).text = "👤"
            itemView.findViewById<TextView>(R.id.userEmailText).text = user.email
            itemView.findViewById<TextView>(R.id.userAccessScopeText).text = when (user.scope.mode) {
                "NONE" -> getString(R.string.user_access_scope_none)
                "CUSTOM_FILE" -> getString(R.string.user_access_scope_file, user.scope.name ?: user.scope.path ?: "Selected file")
                "CUSTOM_FOLDER" -> getString(R.string.user_access_scope_folder, user.scope.name ?: user.scope.path ?: "Selected folder")
                else -> getString(R.string.user_access_scope_all)
            }
            val tvLive = itemView.findViewById<TextView>(R.id.userLiveStatusText)
            val tvLast = itemView.findViewById<TextView>(R.id.userLastActiveText)
            val userIsLive = user.sharingEnabled && user.isLive && vm.nodeRunning
            if (!user.sharingEnabled) {
                tvLive.text = getString(R.string.user_live_status_stopped); tvLive.setTextColor(getColor(R.color.amber))
                tvLast.text = getString(R.string.user_last_active_sharing_stopped); tvLast.setTextColor(getColor(R.color.text_secondary_light))
            } else if (userIsLive) {
                tvLive.text = getString(R.string.user_live_status_live); tvLive.setTextColor(getColor(R.color.emerald))
                tvLast.text = getString(R.string.user_last_active_now); tvLast.setTextColor(getColor(R.color.emerald))
            } else if (vm.nodeRunning) {
                tvLive.text = getString(R.string.user_live_status_offline); tvLive.setTextColor(getColor(R.color.text_secondary_light))
                tvLast.text = getString(R.string.user_last_active_format, vm.formatLastSeenOrTimestamp(user.lastSeenAt, storage.lastLiveTimestamp))
                tvLast.setTextColor(getColor(R.color.text_secondary_light))
            } else {
                tvLive.text = getString(R.string.user_live_status_paused); tvLive.setTextColor(getColor(R.color.amber))
                tvLast.text = getString(R.string.user_last_active_format, vm.formatLastSeenOrTimestamp(user.lastSeenAt, storage.lastLiveTimestamp))
                tvLast.setTextColor(getColor(R.color.text_secondary_light))
            }
            itemView.setOnClickListener { showClientDetailsDialog(user) }
            binding.layoutConnectedAccountsList.addView(itemView)
        }
    }

    // ── Broker status fetch (delegates to controller) ──

    private fun fetchLiveBrokerStatus() {
        accountsCtrl.fetchLiveBrokerStatus(
            onUpdateWidget = { StashlyWidgetProvider.updateAll(this) },
            onRenderUsers = { renderConnectedAccounts(it) },
            onUpdateTimestamp = { binding.lastActiveTimestampText.text = getString(R.string.last_synced_format, it) },
            onUnlinked = { handleConnectionRemoved() }
        )
    }

    // ── Dialogs ──

    private fun showPendingClientRemovedDialog() {
        val removedUserId = storage.pendingClientRemovedUserId ?: return
        if (clientRemovedDialog?.isShowing == true) return
        val removedEmail = runCatching {
            val users = org.json.JSONArray(storage.connectedUsersJson ?: "[]")
            (0 until users.length()).map { users.getJSONObject(it) }.firstOrNull { it.optString("userId") == removedUserId }?.optString("email")
        }.getOrNull().orEmpty()
        clientRemovedDialog = AlertDialog.Builder(this)
            .setTitle(getString(R.string.dialog_client_removed_title))
            .setMessage(getString(R.string.dialog_client_removed_msg, removedEmail.ifEmpty { "A client" }))
            .setPositiveButton(getString(R.string.dialog_btn_ok)) { dialog, _ ->
                storage.pendingClientRemovedUserId = null; dialog.dismiss(); clientRemovedDialog = null
                if (storage.pendingFinalRemovalReason != null) { storage.pendingFinalRemovalReason = null; handleConnectionRemoved() }
            }.setCancelable(false).create()
        clientRemovedDialog?.show()
    }

    private fun handleConnectionRemoved() {
        stopService(Intent(this, StorageNodeService::class.java))
        getSystemService(NotificationManager::class.java)?.cancel(1)
        storage.clear(); refreshAll(); showPage(1)
        Toast.makeText(this, getString(R.string.toast_node_unlinked), Toast.LENGTH_LONG).show()
        if (!isFinishing && !isDestroyed) {
            AlertDialog.Builder(this).setTitle(getString(R.string.dialog_unlinked_title)).setMessage(getString(R.string.dialog_unlinked_msg))
                .setPositiveButton(getString(R.string.dialog_btn_ok), null).show()
        }
    }

    private fun showClientDetailsDialog(user: ConnectedUser) {
        val status = when { !user.sharingEnabled -> getString(R.string.client_status_sharing_stopped); user.isLive -> getString(R.string.client_status_online); else -> getString(R.string.client_status_offline) }
        val lastSeen = if (user.isLive && user.sharingEnabled) getString(R.string.client_last_seen_now) else getString(R.string.client_last_seen_at, vm.formatLastSeenOrTimestamp(user.lastSeenAt, storage.lastLiveTimestamp))
        AlertDialog.Builder(this).setTitle(user.email)
            .setMessage(getString(R.string.client_details_msg, status, lastSeen, vm.formatLastSeenOrTimestamp(user.connectedAt, 0L)))
            .setNegativeButton(getString(R.string.dialog_btn_cancel), null)
            .setNeutralButton(getString(R.string.btn_remove_client_connection)) { _, _ -> showClientActionConfirmation(user, removeConnection = true) }
            .setPositiveButton(getString(if (user.sharingEnabled) R.string.btn_stop_sharing else R.string.btn_start_sharing)) { _, _ -> showClientActionConfirmation(user, removeConnection = false) }
            .setCancelable(true).create().show()
    }

    private fun showClientActionConfirmation(user: ConnectedUser, removeConnection: Boolean) {
        val actionLabel = if (removeConnection) getString(R.string.btn_remove_client_connection) else if (user.sharingEnabled) getString(R.string.btn_stop_sharing) else getString(R.string.btn_start_sharing)
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.dialog_confirm_client_action_title))
            .setMessage(getString(if (removeConnection) R.string.dialog_confirm_remove_client_msg else R.string.dialog_confirm_sharing_msg, user.email, actionLabel))
            .setNegativeButton(getString(R.string.dialog_btn_cancel), null)
            .setPositiveButton(actionLabel) { _, _ ->
                if (removeConnection) accountsCtrl.removeClientConnection(user,
                    onSuccess = { Toast.makeText(this, getString(R.string.toast_client_connection_removed), Toast.LENGTH_SHORT).show() },
                    onRefresh = { fetchLiveBrokerStatus() },
                    onError = { Toast.makeText(this, getString(R.string.toast_access_scope_error, it), Toast.LENGTH_LONG).show() })
                else accountsCtrl.setClientSharing(user, !user.sharingEnabled,
                    onSuccess = { enabled -> Toast.makeText(this, getString(if (enabled) R.string.toast_client_sharing_started else R.string.toast_client_sharing_stopped), Toast.LENGTH_SHORT).show() },
                    onRefresh = { fetchLiveBrokerStatus() },
                    onError = { Toast.makeText(this, getString(R.string.toast_access_scope_error, it), Toast.LENGTH_LONG).show() })
            }.setCancelable(true).show()
    }

    private fun showAccessScopeDialog(pairing: PairingResult) {
        vm.pendingScopeTargetUserId = pairing.userId
        val optionLayout = android.widget.LinearLayout(this).apply { orientation = android.widget.LinearLayout.VERTICAL; setPadding(32, 8, 32, 0) }
        lateinit var dialog: AlertDialog
        fun addOption(label: String, action: () -> Unit) {
            optionLayout.addView(android.widget.Button(this).apply { text = label; setOnClickListener { dialog.dismiss(); action() } })
        }
        addOption(getString(R.string.scope_option_all)) { SystemPermissionCoordinator.withStorageAccess({ doSavePairingScope(pairing, AccessScope()) }, ::showStorageAccessRequired) }
        addOption(getString(R.string.scope_option_folder)) { SystemPermissionCoordinator.withStorageAccess({ beginFolderScopePicker(pairing) }, ::showStorageAccessRequired) }
        addOption(getString(R.string.scope_option_file)) { SystemPermissionCoordinator.withStorageAccess({ beginFileScopePicker(pairing) }, ::showStorageAccessRequired) }
        dialog = AlertDialog.Builder(this).setTitle(getString(R.string.dialog_access_scope_title)).setMessage(getString(R.string.dialog_access_scope_msg, pairing.userEmail ?: "this client")).setView(optionLayout)
            .setNegativeButton(getString(R.string.dialog_btn_cancel)) { _, _ -> vm.pendingScopePairing = null; if (vm.pendingScopeIsPairing) storage.nodeEnabled = false }
            .setCancelable(false).create()
        dialog.show()
    }

    private fun showStorageAccessRequired() {
        AlertDialog.Builder(this).setTitle("Device storage access required")
            .setMessage("Allow Stashly full device storage access before assigning files or folders to a client.")
            .setPositiveButton("Open settings") { _, _ ->
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION).apply { data = Uri.parse("package:$packageName") })
            }.setNegativeButton(getString(R.string.dialog_btn_cancel), null).show()
    }

    // ── Scope picker launchers ──

    private fun beginFolderScopePicker(pairing: PairingResult) {
        vm.pendingScopePairing = pairing
        try { folderPickerLauncher.launch(null) }
        catch (e: Exception) { vm.pendingScopePairing = null; Toast.makeText(this, getString(R.string.toast_folder_picker_error, e.message ?: ""), Toast.LENGTH_SHORT).show() }
    }

    private fun beginFileScopePicker(pairing: PairingResult) {
        vm.pendingScopePairing = pairing
        try { filePickerLauncher.launch(arrayOf("*/*")) }
        catch (e: Exception) { vm.pendingScopePairing = null; Toast.makeText(this, getString(R.string.toast_folder_picker_error, e.message ?: ""), Toast.LENGTH_SHORT).show() }
    }

    private fun doSavePairingScope(pairing: PairingResult, scope: AccessScope) {
        pairingCtrl.savePairingScope(pairing, scope,
            onStartService = { startForegroundService(Intent(this, StorageNodeService::class.java)) },
            onSuccess = { isPairing ->
                Toast.makeText(this, getString(if (isPairing) R.string.toast_paired_success else R.string.toast_access_scope_saved), Toast.LENGTH_LONG).show()
                if (isPairing) { binding.inputPairingToken.setText(""); showPage(0) }; refreshAll()
            },
            onError = { Toast.makeText(this, getString(R.string.toast_access_scope_error, it), Toast.LENGTH_LONG).show() }
        )
    }

    // ── QR scanning ──

    private fun onScanQrClicked() {
        qrScanLauncher.launch(ScanOptions().apply {
            setDesiredBarcodeFormats(ScanOptions.QR_CODE); setPrompt(getString(R.string.qr_scan_prompt))
            setCameraId(0); setBeepEnabled(false); setBarcodeImageEnabled(false); setOrientationLocked(false)
            setCaptureActivity(PortraitCaptureActivity::class.java)
        })
    }

    private fun handleScannedQr(rawText: String) {
        if (binding.inputDeviceName.text.isNullOrEmpty()) binding.inputDeviceName.setText(Build.MODEL)
        when (val result = pairingCtrl.parseScannedQr(rawText, !binding.inputBrokerUrl.text.isNullOrEmpty())) {
            is PairingFlowController.QrParseResult.AutoPair -> {
                if (result.brokerUrl != null) binding.inputBrokerUrl.setText(result.brokerUrl)
                if (result.token != null) binding.inputPairingToken.setText(result.token)
                Toast.makeText(this, getString(R.string.toast_qr_autopair), Toast.LENGTH_SHORT).show(); onPairClicked()
            }
            is PairingFlowController.QrParseResult.TokenOnly -> {
                binding.inputPairingToken.setText(result.token)
                Toast.makeText(this, getString(R.string.toast_qr_code_loaded, result.token), Toast.LENGTH_SHORT).show()
                if (result.hasBrokerUrl) onPairClicked()
            }
            is PairingFlowController.QrParseResult.Error ->
                Toast.makeText(this, getString(R.string.toast_qr_parse_error, result.message), Toast.LENGTH_LONG).show()
        }
    }

    // ── Pairing ──

    private fun onPairClicked() {
        if (binding.inputDeviceName.text.isNullOrEmpty()) binding.inputDeviceName.setText(Build.MODEL)
        pairingCtrl.executePairing(
            context = this,
            rawBrokerUrl = binding.inputBrokerUrl.text?.toString()?.trim().orEmpty(),
            deviceName = binding.inputDeviceName.text?.toString()?.trim().orEmpty(),
            rawPairingToken = binding.inputPairingToken.text?.toString()?.trim()?.uppercase(Locale.ROOT).orEmpty(),
            onValidationError = { Toast.makeText(this, getString(R.string.toast_fill_fields), Toast.LENGTH_SHORT).show() },
            onNeedsStoragePermission = { showStorageAccessRequired() },
            onPairingStarted = {
                binding.btnSubmitPair.isEnabled = false; binding.btnSubmitPair.text = getString(R.string.btn_pairing_progress)
                pairingProgressDialog = AlertDialog.Builder(this).setTitle(getString(R.string.dialog_pairing_title)).setMessage(getString(R.string.dialog_pairing_msg)).setView(ProgressBar(this)).setCancelable(false).show()
            },
            onPairingSuccess = { result, _ ->
                stopService(Intent(this, StorageNodeService::class.java))
                pairingProgressDialog?.dismiss(); pairingProgressDialog = null
                showAccessScopeDialog(result)
            },
            onPairingError = { e, targetUrl ->
                pairingProgressDialog?.dismiss(); pairingProgressDialog = null
                val msg = if (e.message?.contains("Failed to connect", ignoreCase = true) == true) getString(R.string.toast_pairing_error_network, targetUrl)
                else getString(R.string.toast_pairing_error_general, e.message ?: "")
                Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
            },
            onPairingFinished = { binding.btnSubmitPair.isEnabled = true; binding.btnSubmitPair.text = getString(R.string.btn_pair_submit) }
        )
    }

    // ── Master key / Bluetooth ──

    private fun onShowMasterKeyClicked() {
        val key = storage.masterKeyBase64 ?: run { Toast.makeText(this, getString(R.string.toast_no_key), Toast.LENGTH_SHORT).show(); return }
        AlertDialog.Builder(this).setTitle(getString(R.string.dialog_master_key_title))
            .setItems(arrayOf("\uD83D\uDCCB  Copy to Clipboard", "\uD83D\uDCF6  Share via Bluetooth", "\uD83D\uDC41  View Key")) { _, which ->
                when (which) {
                    0 -> { copyToClipboard(key); Toast.makeText(this, getString(R.string.toast_master_key_copied), Toast.LENGTH_SHORT).show() }
                    1 -> requestBluetoothPermissionsAndShare()
                    2 -> AlertDialog.Builder(this).setTitle("Master Key").setMessage(getString(R.string.dialog_master_key_msg, key))
                        .setNeutralButton(getString(R.string.dialog_btn_copy_key)) { _, _ -> copyToClipboard(key); Toast.makeText(this, getString(R.string.toast_master_key_copied), Toast.LENGTH_SHORT).show() }
                        .setPositiveButton(getString(R.string.dialog_btn_ok), null).show()
                }
            }.setNegativeButton(getString(R.string.dialog_btn_cancel), null).show()
    }

    private fun copyToClipboard(text: String) {
        (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Stashly master key", text))
    }

    @SuppressLint("MissingPermission")
    private fun requestBluetoothPermissionsAndShare() {
        val needed = btCoordinator.getNeededPermissions { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }
        if (needed.isNotEmpty()) { blePermissionLauncher.launch(needed); return }
        checkBluetoothAndShare()
    }

    @SuppressLint("MissingPermission")
    private fun checkBluetoothAndShare() {
        when (btCoordinator.checkBluetoothState()) {
            BluetoothPairingCoordinator.BluetoothState.NOT_AVAILABLE -> Toast.makeText(this, "Bluetooth is not available on this device.", Toast.LENGTH_LONG).show()
            BluetoothPairingCoordinator.BluetoothState.DISABLED -> AlertDialog.Builder(this).setTitle("Bluetooth Required")
                .setMessage("Bluetooth must be turned on to share your master key.\n\nThe web browser needs to discover this device via Bluetooth to securely receive the encryption key.")
                .setPositiveButton("Turn On Bluetooth") { _, _ -> @Suppress("DEPRECATION") bleEnableLauncher.launch(Intent(android.bluetooth.BluetoothAdapter.ACTION_REQUEST_ENABLE)) }
                .setNegativeButton(getString(R.string.dialog_btn_cancel), null).show()
            BluetoothPairingCoordinator.BluetoothState.READY -> onStartBluetoothKeyShare()
        }
    }

    @SuppressLint("MissingPermission")
    private fun onStartBluetoothKeyShare() {
        if (btCoordinator.checkBluetoothState() != BluetoothPairingCoordinator.BluetoothState.READY) { checkBluetoothAndShare(); return }
        val key = storage.masterKeyBase64 ?: run { Toast.makeText(this, getString(R.string.toast_no_key), Toast.LENGTH_SHORT).show(); return }
        bleKeyShareServer?.stop()
        bleKeyShareServer = btCoordinator.createServer(masterKeyBase64 = key,
            onPinGenerated = { pin -> runOnUiThread { showBleDialog("Confirm Pairing PIN", "A web client has connected.\n\nVerify this PIN matches the one shown in the browser:\n\n       $pin\n\nIf the PINs match, the master key will be shared securely.", showCancel = true) } },
            onClientConnected = { name -> runOnUiThread { showBleDialog("Client Connected", "$name connected.\nPerforming secure key exchange...") } },
            onTransferComplete = { runOnUiThread { dismissBleSession(); AlertDialog.Builder(this).setTitle("Key Shared Successfully").setMessage("Your master key has been securely transferred to the connected web client via Bluetooth.\n\nThe web browser can now decrypt your vault files.").setPositiveButton(getString(R.string.dialog_btn_ok), null).show() } },
            onError = { msg -> runOnUiThread { dismissBleSession(); Toast.makeText(this, "Bluetooth error: $msg", Toast.LENGTH_LONG).show() } }
        )
        bleKeyShareServer!!.start()
        showBleDialog("Waiting for Connection", "Your device is now advertising via Bluetooth.\n\nOn the web dashboard, open the Master Key drawer and tap \"Bluetooth Transfer\", then select this device.\n\nThe connection will timeout in 2 minutes.", showCancel = true)
    }

    private fun showBleDialog(title: String, message: String, showCancel: Boolean = false) {
        bleShareDialog?.dismiss()
        val builder = AlertDialog.Builder(this).setTitle(title).setMessage(message).setCancelable(false)
        if (showCancel) builder.setNegativeButton("Cancel") { _, _ -> dismissBleSession(); Toast.makeText(this, "Bluetooth key share cancelled.", Toast.LENGTH_SHORT).show() }
        bleShareDialog = builder.create(); bleShareDialog?.show()
    }

    private fun dismissBleSession() { bleShareDialog?.dismiss(); bleShareDialog = null; bleKeyShareServer?.stop(); bleKeyShareServer = null }

    // ── Reset ──

    private fun onResetNodeClicked() {
        AlertDialog.Builder(this).setTitle(getString(R.string.dialog_reset_title)).setMessage(getString(R.string.dialog_reset_msg))
            .setPositiveButton(getString(R.string.dialog_btn_reset)) { _, _ ->
                nodeCtrl.executeReset(
                    onLocalReset = { nodeCtrl.finishLocalNodeReset(this, onStopService = { stopService(Intent(this, StorageNodeService::class.java)) }) { Toast.makeText(this, getString(R.string.toast_node_cleared), Toast.LENGTH_SHORT).show(); refreshAll(); showPage(1) } },
                    onError = { Toast.makeText(this, getString(R.string.toast_reset_error, it), Toast.LENGTH_LONG).show() }
                )
            }.setNegativeButton(getString(R.string.dialog_btn_cancel), null).show()
    }
}

/**
 * Custom CaptureActivity for ZXing barcode scanner that adapts to the
 * mobile device's orientation (portrait / sensor) rather than default landscape.
 */
class PortraitCaptureActivity : CaptureActivity()
