package com.stashly.app

import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.DocumentsContract
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.stashly.app.databinding.ActivityClientStorageAccessBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray

class ClientStorageAccessActivity : AppCompatActivity() {
    private lateinit var binding: ActivityClientStorageAccessBinding
    private lateinit var storage: SecureStorage
    private var pendingUser: ConnectedUser? = null
    private var pendingScopeType: String? = null

    private val folderPicker = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        if (uri != null) savePickedScope(uri, isFile = false)
    }

    private val filePicker = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) savePickedScope(uri, isFile = true)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityClientStorageAccessBinding.inflate(layoutInflater)
        setContentView(binding.root)
        storage = SecureStorage(this)
        binding.clientAccessToolbar.setNavigationOnClickListener { finish() }
        loadClients()
    }

    private fun loadClients() {
        val cachedClients = loadCachedClients()
        if (cachedClients.isNotEmpty()) {
            renderClients(cachedClients, "Refreshing connected clients...")
        } else {
            binding.clientAccessMessage.text = "Loading connected clients..."
        }

        val brokerUrl = storage.brokerBaseUrl
        val token = storage.deviceToken
        if (brokerUrl.isNullOrEmpty() || token.isNullOrEmpty()) {
            if (cachedClients.isEmpty()) {
                renderClients(emptyList(), "Pair this device before managing client access.")
            }
            return
        }

        lifecycleScope.launch {
            try {
                val info = withContext(Dispatchers.IO) { PairingRepository.fetchSelfInfo(brokerUrl, token) }
                storage.connectedUsersJson = info.users.toCacheJson()
                renderClients(info.users, if (info.users.isEmpty()) "No clients are connected." else "")
            } catch (error: Exception) {
                if (cachedClients.isEmpty()) {
                    renderClients(emptyList(), "Could not load clients: ${error.message ?: "Unknown error"}")
                } else {
                    binding.clientAccessMessage.text = "Showing saved clients. Refresh unavailable."
                }
            }
        }
    }

    private fun loadCachedClients(): List<ConnectedUser> {
        val json = storage.connectedUsersJson ?: return emptyList()
        val result = mutableListOf<ConnectedUser>()
        runCatching {
            val users = JSONArray(json)
            for (index in 0 until users.length()) {
                val user = users.getJSONObject(index)
                result += ConnectedUser(
                    userId = user.optString("userId").ifEmpty { null },
                    email = user.optString("email"),
                    role = user.optString("role", "viewer"),
                    scope = AccessScope(
                        mode = user.optString("scopeMode", "ALL"),
                        path = user.optString("scopePath").ifEmpty { null },
                        name = user.optString("scopeName").ifEmpty { null }
                    ),
                    sharingEnabled = user.optBoolean("sharingEnabled", true),
                    isLive = user.optBoolean("isLive", false),
                    lastSeenAt = user.optString("lastSeenAt").ifEmpty { null },
                    connectedAt = user.optString("connectedAt").ifEmpty { null }
                )
            }
        }
        return result
    }

    private fun List<ConnectedUser>.toCacheJson(): String = JSONArray().apply {
        forEach { user ->
            put(org.json.JSONObject().apply {
                put("email", user.email)
                user.userId?.let { put("userId", it) }
                put("role", user.role)
                put("scopeMode", user.scope.mode)
                user.scope.path?.let { put("scopePath", it) }
                user.scope.name?.let { put("scopeName", it) }
                put("sharingEnabled", user.sharingEnabled)
                put("isLive", user.isLive)
                user.lastSeenAt?.let { put("lastSeenAt", it) }
                user.connectedAt?.let { put("connectedAt", it) }
            })
        }
    }.toString()

    private fun renderClients(users: List<ConnectedUser>, message: String) {
        binding.clientAccessMessage.text = message
        binding.clientAccessList.removeAllViews()
        users.forEach { user ->
            val card = layoutInflater.inflate(R.layout.item_connected_user, binding.clientAccessList, false)
                as com.google.android.material.card.MaterialCardView
            card.findViewById<TextView>(R.id.userEmailText).text = user.email
            card.findViewById<TextView>(R.id.userLiveStatusText).text = if (user.isLive && user.sharingEnabled) "Online" else "Offline"
            card.findViewById<TextView>(R.id.userAccessScopeText).text = formatScope(user.scope)
            card.findViewById<TextView>(R.id.userLastActiveText).text = if (user.sharingEnabled) "Sharing enabled" else "Sharing stopped"

            val content = card.getChildAt(0) as? LinearLayout
            content?.addView(Button(this).apply {
                text = "Change Access"
                setTextColor(ContextCompat.getColor(this@ClientStorageAccessActivity, R.color.primary))
                setOnClickListener { showScopeDialog(user) }
            })
            binding.clientAccessList.addView(card)
        }
    }

    private fun formatScope(scope: AccessScope): String = when (scope.mode) {
        "NONE" -> "Access: None"
        "CUSTOM_FILE" -> "Access: File - ${scope.name ?: scope.path ?: "Selected file"}"
        "CUSTOM_FOLDER" -> "Access: Folder - ${scope.name ?: scope.path ?: "Selected folder"}"
        else -> "Access: All internal storage"
    }

    private fun showScopeDialog(user: ConnectedUser) {
        pendingUser = user
        AlertDialog.Builder(this)
            .setTitle("Change access for ${user.email}")
            .setItems(arrayOf("All internal storage", "Specific folder", "Specific file", "No access")) { _, which ->
                when (which) {
                    0 -> saveScope(user, AccessScope())
                    1 -> { pendingScopeType = "CUSTOM_FOLDER"; folderPicker.launch(null) }
                    2 -> { pendingScopeType = "CUSTOM_FILE"; filePicker.launch(arrayOf("*/*")) }
                    3 -> saveScope(user, AccessScope(mode = "NONE"))
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun savePickedScope(uri: Uri, isFile: Boolean) {
        val user = pendingUser ?: return
        val documentId = runCatching {
            if (isFile) DocumentsContract.getDocumentId(uri) else DocumentsContract.getTreeDocumentId(uri)
        }.getOrNull() ?: uri.lastPathSegment.orEmpty()
        val relativePath = documentId.substringAfter(":", documentId).trim('/')
        val displayName = relativePath.substringAfterLast('/').ifEmpty { if (isFile) "Selected file" else "Selected folder" }
        val virtualPath = if (relativePath.isEmpty()) "/" else "/$relativePath"
        saveScope(user, AccessScope(pendingScopeType ?: if (isFile) "CUSTOM_FILE" else "CUSTOM_FOLDER", virtualPath, displayName))
        pendingUser = null
        pendingScopeType = null
    }

    private fun saveScope(user: ConnectedUser, scope: AccessScope) {
        val brokerUrl = storage.brokerBaseUrl ?: return
        val token = storage.deviceToken ?: return
        val userId = user.userId ?: return
        lifecycleScope.launch {
            try {
                withContext(Dispatchers.IO) {
                    PairingRepository.updateAccessScope(brokerUrl, token, scope, userId)
                }
                Toast.makeText(this@ClientStorageAccessActivity, "Client access updated.", Toast.LENGTH_SHORT).show()
                loadClients()
            } catch (error: Exception) {
                Toast.makeText(this@ClientStorageAccessActivity, "Could not update access: ${error.message ?: "Unknown error"}", Toast.LENGTH_LONG).show()
            }
        }
    }
}
