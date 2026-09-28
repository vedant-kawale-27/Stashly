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
    val userEmail: String? = null
)

data class NodeSelfInfo(
    val id: String,
    val name: String,
    val isLive: Boolean,
    val lastSeenAt: String?,
    val users: List<ConnectedUser>
)

data class ConnectedUser(
    val email: String,
    val role: String
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
                userEmail = json.optString("userEmail", null)
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
            if (usersArray != null) {
                for (i in 0 until usersArray.length()) {
                    val u = usersArray.getJSONObject(i)
                    usersList.add(ConnectedUser(email = u.getString("email"), role = u.optString("role", "owner")))
                }
            }
            return NodeSelfInfo(
                id = json.getString("id"),
                name = json.getString("name"),
                isLive = json.optBoolean("isLive", false),
                lastSeenAt = json.optString("lastSeenAt", null),
                users = usersList
            )
        }
    }
}
