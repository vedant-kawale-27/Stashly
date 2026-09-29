package com.nimbusnode.app

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException

data class PairingResult(
    val deviceId: String,
    val deviceToken: String,
    val userId: String? = null,
    val role: String = "viewer",
    val userEmail: String? = null
)

data class AccessScope(
    val mode: String = "ALL",
    val path: String? = null,
    val name: String? = null
)

data class NodeSelfInfo(
    val id: String,
    val name: String,
    val isLive: Boolean,
    val lastSeenAt: String?,
    val users: List<ConnectedUser>
)

data class ConnectedUser(
    val userId: String? = null,
    val email: String,
    val role: String = "viewer",
    val scope: AccessScope = AccessScope(),
    val sharingEnabled: Boolean = true,
    val isLive: Boolean = false,
    val lastSeenAt: String? = null,
    val connectedAt: String? = null
)

/** One-shot calls to broker device endpoints — see routes/devices.ts. */
object PairingRepository {

    private val client = OkHttpClient()
    private val jsonMediaType = "application/json".toMediaType()

    @Throws(IOException::class)
    fun pair(
        brokerBaseUrl: String,
        pairingToken: String,
        deviceName: String,
        existingDeviceId: String? = null
    ): PairingResult {
        val body = JSONObject().apply {
            put("token", pairingToken)
            put("deviceName", deviceName)
            if (!existingDeviceId.isNullOrEmpty()) {
                put("deviceId", existingDeviceId)
            }
        }.toString().toRequestBody(jsonMediaType)

        val request = Request.Builder()
            .url(brokerBaseUrl.trimEnd('/') + "/devices/pair")
            .post(body)
            .build()

        client.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                val error = runCatching { JSONObject(text).optString("error") }.getOrNull()
                throw IOException(error ?: "Pairing failed (HTTP ${response.code})")
            }
            val json = JSONObject(text)
            return PairingResult(
                deviceId = json.getString("deviceId"),
                deviceToken = json.getString("deviceToken"),
                userId = json.optString("userId").ifEmpty { null },
                role = json.optString("role", "viewer"),
                userEmail = json.optString("userEmail").ifEmpty { null }
            )
        }
    }

    @Throws(IOException::class)
    fun fetchSelfInfo(brokerBaseUrl: String, deviceToken: String): NodeSelfInfo {
        val request = Request.Builder()
            .url(brokerBaseUrl.trimEnd('/') + "/devices/self")
            .header("Authorization", "Bearer $deviceToken")
            .get()
            .build()

        client.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                throw IOException("Failed to fetch node info (HTTP ${response.code})")
            }
            val json = JSONObject(text)
            val usersArray = json.optJSONArray("users")
            val usersList = mutableListOf<ConnectedUser>()
            val nodeIsLive = json.optBoolean("isLive", false)
            val nodeLastSeenAt = json.optString("lastSeenAt").ifEmpty { null }
            if (usersArray != null) {
                for (i in 0 until usersArray.length()) {
                    val u = usersArray.getJSONObject(i)
                    usersList.add(
                        ConnectedUser(
                            userId = u.optString("userId").ifEmpty { null },
                            email = u.getString("email"),
                            role = u.optString("role", "viewer"),
                            scope = AccessScope(
                                mode = u.optString("scopeMode", "ALL"),
                                path = u.optString("scopePath").ifEmpty { null },
                                name = u.optString("scopeName").ifEmpty { null }
                            ),
                            sharingEnabled = u.optBoolean("sharingEnabled", true),
                            isLive = u.optBoolean("isLive", nodeIsLive),
                            lastSeenAt = if (u.has("lastSeenAt") && !u.isNull("lastSeenAt")) u.getString("lastSeenAt") else null,
                            connectedAt = u.optString("connectedAt").ifEmpty { null }
                        )
                    )
                }
            }
            return NodeSelfInfo(
                id = json.getString("id"),
                name = json.getString("name"),
                isLive = nodeIsLive,
                lastSeenAt = nodeLastSeenAt,
                users = usersList
            )
        }
    }

    @Throws(IOException::class)
    fun updateAccessScope(
        brokerBaseUrl: String,
        deviceToken: String,
        scope: AccessScope,
        targetUserId: String? = null
    ): AccessScope {
        val body = JSONObject().apply {
            put("scopeMode", scope.mode)
            if (targetUserId != null) put("targetUserId", targetUserId)
            if (scope.path != null) put("scopePath", scope.path)
            if (scope.name != null) put("scopeName", scope.name)
        }.toString().toRequestBody(jsonMediaType)

        val request = Request.Builder()
            .url(brokerBaseUrl.trimEnd('/') + "/devices/self/scope")
            .header("Authorization", "Bearer $deviceToken")
            .put(body)
            .build()

        client.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                val error = runCatching { JSONObject(text).optString("error") }.getOrNull()
                throw IOException(error ?: "Failed to save access scope (HTTP ${response.code})")
            }
            val json = JSONObject(text)
            return AccessScope(
                mode = json.optString("scopeMode", "ALL"),
                path = json.optString("scopePath").ifEmpty { null },
                name = json.optString("scopeName").ifEmpty { null }
            )
        }
    }

    @Throws(IOException::class)
    fun removeClientAccess(brokerBaseUrl: String, deviceToken: String, targetUserId: String) {
        val request = Request.Builder()
            .url(brokerBaseUrl.trimEnd('/') + "/devices/self/client/$targetUserId")
            .header("Authorization", "Bearer $deviceToken")
            .delete()
            .build()

        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful && response.code != 204) {
                val text = response.body?.string().orEmpty()
                val error = runCatching { JSONObject(text).optString("error") }.getOrNull()
                throw IOException(error ?: "Failed to stop sharing with client (HTTP ${response.code})")
            }
        }
    }

    @Throws(IOException::class)
    fun setClientSharing(brokerBaseUrl: String, deviceToken: String, targetUserId: String, enabled: Boolean) {
        val body = JSONObject().put("enabled", enabled)
            .toString().toRequestBody(jsonMediaType)
        val request = Request.Builder()
            .url(brokerBaseUrl.trimEnd('/') + "/devices/self/client/$targetUserId/sharing")
            .header("Authorization", "Bearer $deviceToken")
            .put(body)
            .build()

        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                val text = response.body?.string().orEmpty()
                val error = runCatching { JSONObject(text).optString("error") }.getOrNull()
                throw IOException(error ?: "Failed to update client sharing (HTTP ${response.code})")
            }
        }
    }

    @Throws(IOException::class)
    fun resetNode(brokerBaseUrl: String, deviceToken: String) {
        val request = Request.Builder()
            .url(brokerBaseUrl.trimEnd('/') + "/devices/self/reset")
            .header("Authorization", "Bearer $deviceToken")
            .delete()
            .build()

        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful && response.code != 204) {
                val text = response.body?.string().orEmpty()
                val error = runCatching { JSONObject(text).optString("error") }.getOrNull()
                throw IOException(error ?: "Failed to reset node (HTTP ${response.code})")
            }
        }
    }
}
