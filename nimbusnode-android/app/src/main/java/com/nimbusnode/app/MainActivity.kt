package com.nimbusnode.app

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.PowerManager
import android.os.StatFs
import android.provider.DocumentsContract
import android.provider.Settings
import android.view.View
import android.graphics.Typeface
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.net.toUri
import com.journeyapps.barcodescanner.CaptureActivity
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import com.nimbusnode.app.databinding.ActivityMainBinding
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var storage: SecureStorage

    private val qrScanLauncher = registerForActivityResult(ScanContract()) { result ->
        if (result.contents != null) {
            handleScannedQr(result.contents)
        }
    }

    private val folderPickerLauncher = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        if (uri != null) {
            handleSelectedFolderUri(uri)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        storage = SecureStorage(this)

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
        binding.btnSelectFolder.setOnClickListener { onSelectFolderClicked() }
        binding.btnResetFolderScope.setOnClickListener { onResetToWholeStorageClicked() }
        binding.btnShowMasterKey.setOnClickListener { onShowMasterKeyClicked() }
        binding.btnResetNode.setOnClickListener { onResetNodeClicked() }

        // Start Foreground Service if paired and enabled
        if (storage.isPaired && storage.nodeEnabled) {
            startForegroundService(Intent(this, StorageNodeService::class.java))
        }

        // Initial view setup
        showPage(0)
        refreshAll()
    }

    override fun onResume() {
        super.onResume()
        refreshAll()
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
            val scopeMode = storage.storageScopeMode
            val customName = storage.customFolderDisplayName
            if (scopeMode == "CUSTOM_FOLDER" && !customName.isNullOrEmpty()) {
                binding.storageScopeBadgeText.text = getString(R.string.storage_scope_scoped, customName)
            } else {
                binding.storageScopeBadgeText.text = getString(R.string.storage_scope_all)
            }

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

            // Display Connected Accounts List
            val cachedUsers = loadCachedConnectedUsers()
            if (cachedUsers.isNotEmpty()) {
                renderConnectedAccounts(cachedUsers)
            } else {
                val email = storage.userEmail
                binding.layoutAccountEmailRow.visibility = View.VISIBLE
                binding.accountEmailText.text = if (!email.isNullOrEmpty()) {
                    getString(R.string.account_email_format, email)
                } else {
                    getString(R.string.account_email_default)
                }
            }

            // Display Live Status & Last Live
            if (storage.isLive) {
                binding.liveStatusText.text = getString(R.string.status_live_now)
                binding.lastLiveText.text = getString(R.string.last_live_active)
            } else if (isRunning) {
                binding.liveStatusText.text = getString(R.string.status_offline_reconnecting)
                binding.lastLiveText.text = formatLastLive(storage.lastLiveTimestamp)
            } else {
                binding.liveStatusText.text = getString(R.string.status_paused)
                binding.lastLiveText.text = formatLastLive(storage.lastLiveTimestamp)
            }

            val now = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())
            binding.lastActiveTimestampText.text = getString(R.string.last_synced_format, now)
            binding.clientSecurityInfoText.text = getString(R.string.client_security_info)
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

    private fun loadCachedConnectedUsers(): List<ConnectedUser> {
        val jsonStr = storage.connectedUsersJson ?: return emptyList()
        val list = mutableListOf<ConnectedUser>()
        try {
            val array = JSONArray(jsonStr)
            for (i in 0 until array.length()) {
                val obj = array.getJSONObject(i)
                list.add(ConnectedUser(email = obj.getString("email"), role = obj.getString("role")))
            }
        } catch (_: Exception) {}
        return list
    }

    private fun renderConnectedAccounts(users: List<ConnectedUser>) {
        binding.layoutConnectedAccountsList.removeAllViews()
        if (users.isEmpty()) {
            binding.layoutAccountEmailRow.visibility = View.VISIBLE
            val email = storage.userEmail
            binding.accountEmailText.text = if (!email.isNullOrEmpty()) {
                getString(R.string.account_email_format, email)
            } else {
                getString(R.string.account_email_default)
            }
            return
        }

        binding.layoutAccountEmailRow.visibility = View.GONE
        for (user in users) {
            val isOwner = user.role.equals("owner", ignoreCase = true)
            val icon = if (isOwner) "👑" else "👤"
            val roleLabel = if (isOwner) getString(R.string.role_owner) else getString(R.string.role_viewer)

            val itemView = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = android.view.Gravity.CENTER_VERTICAL
                setPadding(0, 6, 0, 6)
            }

            val tvIcon = TextView(this).apply {
                text = getString(R.string.icon_format, icon)
                textSize = 14f
            }

            val tvEmail = TextView(this).apply {
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                text = user.email
                setTextColor(getColor(R.color.text_primary_light))
                textSize = 13f
                typeface = Typeface.DEFAULT_BOLD
            }

            val tvBadge = TextView(this).apply {
                text = roleLabel
                setTextColor(if (isOwner) getColor(R.color.primary_dark) else getColor(R.color.text_secondary_light))
                setBackgroundColor(if (isOwner) getColor(R.color.primary_light) else getColor(R.color.surface_subtle_light))
                setPadding(12, 4, 12, 4)
                textSize = 11f
                typeface = Typeface.DEFAULT_BOLD
            }

            itemView.addView(tvIcon)
            itemView.addView(tvEmail)
            itemView.addView(tvBadge)
            binding.layoutConnectedAccountsList.addView(itemView)
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
                    if (selfInfo.users.isNotEmpty()) {
                        val usersJson = JSONArray().apply {
                            selfInfo.users.forEach { u ->
                                put(JSONObject().apply {
                                    put("email", u.email)
                                    put("role", u.role)
                                })
                            }
                        }.toString()
                        storage.connectedUsersJson = usersJson
                        storage.userEmail = selfInfo.users.first().email
                        renderConnectedAccounts(selfInfo.users)
                    }
                    if (selfInfo.isLive) {
                        storage.isLive = true
                    }
                    if (storage.lastLiveTimestamp == 0L && selfInfo.lastSeenAt != null) {
                        // Keep broker last seen if local timestamp is not yet set
                        binding.lastLiveText.text = selfInfo.lastSeenAt
                    }
                }
            } catch (_: Exception) {
                // Ignore transient network errors when fetching broker status
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

        val scopeMode = storage.storageScopeMode
        val customName = storage.customFolderDisplayName
        val customPath = storage.customFolderPath

        if (scopeMode == "CUSTOM_FOLDER" && !customPath.isNullOrEmpty()) {
            binding.storageScopeStatusText.text = getString(
                R.string.storage_scope_folder_status,
                customName ?: getString(R.string.folder_selected_default)
            )
            binding.storagePermissionStatusText.text = getString(R.string.storage_restricted_to, customPath)
            binding.btnResetFolderScope.visibility = View.VISIBLE
            binding.btnSelectFolder.text = getString(R.string.btn_change_folder)
        } else {
            binding.storageScopeStatusText.text = getString(R.string.storage_scope_all_status)
            binding.storagePermissionStatusText.text = getString(
                if (hasAllFilesAccess) R.string.storage_full_access_desc else R.string.storage_limited_access_desc
            )
            binding.btnResetFolderScope.visibility = View.GONE
            binding.btnSelectFolder.text = getString(R.string.btn_choose_folder)
        }

        binding.btnStoragePermission.isEnabled = !hasAllFilesAccess
        if (hasAllFilesAccess) {
            binding.btnStoragePermission.text = getString(R.string.btn_granted)
        } else {
            binding.btnStoragePermission.text = getString(R.string.btn_all_storage)
        }
    }

    private fun onSelectFolderClicked() {
        try {
            folderPickerLauncher.launch(null)
        } catch (e: Exception) {
            Toast.makeText(this, getString(R.string.toast_folder_picker_error, e.message ?: ""), Toast.LENGTH_SHORT).show()
        }
    }

    private fun handleSelectedFolderUri(uri: Uri) {
        try {
            val takeFlags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            contentResolver.takePersistableUriPermission(uri, takeFlags)
        } catch (_: Exception) {}

        val docId = try {
            DocumentsContract.getTreeDocumentId(uri)
        } catch (_: Exception) {
            uri.lastPathSegment ?: ""
        }

        val split = docId.split(":")
        val type = split.getOrNull(0) ?: "primary"
        val relativePath = if (split.size > 1) split[1].trim('/') else ""

        if (type.equals("primary", ignoreCase = true)) {
            val rootFile = Environment.getExternalStorageDirectory()
            if (relativePath.isEmpty() || relativePath == "/") {
                // Selected top-level root
                storage.storageScopeMode = "ALL"
                storage.customFolderPath = rootFile.absolutePath
                storage.customFolderUri = uri.toString()
                storage.customFolderDisplayName = getString(R.string.toast_scope_internal_all)
                Toast.makeText(this, getString(R.string.toast_scope_internal_all), Toast.LENGTH_LONG).show()
            } else {
                // Selected specific folder
                val targetFolder = File(rootFile, relativePath)
                val folderName = relativePath.substringAfterLast('/')
                storage.storageScopeMode = "CUSTOM_FOLDER"
                storage.customFolderPath = targetFolder.absolutePath
                storage.customFolderUri = uri.toString()
                storage.customFolderDisplayName = folderName
                Toast.makeText(this, getString(R.string.toast_scope_folder, folderName), Toast.LENGTH_LONG).show()
            }
        } else {
            val folderName = relativePath.ifEmpty { type }
            storage.storageScopeMode = "CUSTOM_FOLDER"
            storage.customFolderUri = uri.toString()
            storage.customFolderDisplayName = folderName
            storage.customFolderPath = "/storage/$type/$relativePath"
            Toast.makeText(this, getString(R.string.toast_scope_folder, folderName), Toast.LENGTH_LONG).show()
        }

        // Reset encrypted cache so only files from the new scope are served
        val keyManager = KeyManager(storage)
        val vault = FileVault(this, keyManager, storage)
        vault.clearVaultCache()

        refreshPermissions()
        refreshStorageMeter()

        if (storage.isPaired && storage.nodeEnabled) {
            startForegroundService(Intent(this, StorageNodeService::class.java).apply {
                action = StorageNodeService.ACTION_SYNC_NOW
            })
        }
    }

    private fun onResetToWholeStorageClicked() {
        storage.storageScopeMode = "ALL"
        storage.customFolderPath = null
        storage.customFolderUri = null
        storage.customFolderDisplayName = null

        val keyManager = KeyManager(storage)
        val vault = FileVault(this, keyManager, storage)
        vault.clearVaultCache()

        Toast.makeText(this, getString(R.string.toast_scope_reset), Toast.LENGTH_SHORT).show()
        refreshPermissions()
        refreshStorageMeter()

        if (storage.isPaired && storage.nodeEnabled) {
            startForegroundService(Intent(this, StorageNodeService::class.java).apply {
                action = StorageNodeService.ACTION_SYNC_NOW
            })
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
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val keyManager = KeyManager(storage)
                val vault = FileVault(this@MainActivity, keyManager, storage)
                vault.scanAndSync()
                withContext(Dispatchers.Main) {
                    Toast.makeText(this@MainActivity, getString(R.string.toast_sync_success), Toast.LENGTH_SHORT).show()
                    refreshNodeStatus()
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    Toast.makeText(this@MainActivity, getString(R.string.toast_sync_error, e.message ?: ""), Toast.LENGTH_LONG).show()
                }
            }
        }
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

        val targetUrl = brokerUrl
        CoroutineScope(Dispatchers.Main).launch {
            try {
                val result = withContext(Dispatchers.IO) {
                    PairingRepository.pair(
                        targetUrl,
                        pairingToken,
                        deviceName,
                        existingDeviceId = storage.deviceId
                    )
                }
                storage.brokerBaseUrl = targetUrl
                storage.deviceId = result.deviceId
                storage.deviceToken = result.deviceToken
                if (result.userEmail != null) {
                    storage.userEmail = result.userEmail
                }
                storage.nodeEnabled = true

                stopService(Intent(this@MainActivity, StorageNodeService::class.java))
                startForegroundService(Intent(this@MainActivity, StorageNodeService::class.java))

                Toast.makeText(this@MainActivity, getString(R.string.toast_paired_success), Toast.LENGTH_LONG).show()
                binding.inputPairingToken.setText("")
                showPage(0)
                refreshAll()
            } catch (e: Exception) {
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

        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("Stashly Master Key", key))

        AlertDialog.Builder(this)
            .setTitle(getString(R.string.dialog_master_key_title))
            .setMessage(getString(R.string.dialog_master_key_msg, key))
            .setPositiveButton(getString(R.string.dialog_btn_ok), null)
            .show()
    }

    private fun onResetNodeClicked() {
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.dialog_reset_title))
            .setMessage(getString(R.string.dialog_reset_msg))
            .setPositiveButton(getString(R.string.dialog_btn_reset)) { _, _ ->
                stopService(Intent(this, StorageNodeService::class.java))
                storage.clear()
                Toast.makeText(this, getString(R.string.toast_node_cleared), Toast.LENGTH_SHORT).show()
                refreshAll()
                showPage(1)
            }
            .setNegativeButton(getString(R.string.dialog_btn_cancel), null)
            .show()
    }
}

/**
 * Custom CaptureActivity for ZXing barcode scanner that adapts to the
 * mobile device's orientation (portrait / sensor) rather than default landscape.
 */
class PortraitCaptureActivity : CaptureActivity()

