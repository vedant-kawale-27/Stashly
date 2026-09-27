package com.nimbusnode.app

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException

data class PairingResult(val deviceId: String, val deviceToken: String)

/** One-shot call to `POST /devices/pair` — see the broker's routes/devices.ts. */
object PairingRepository {

    private val client = OkHttpClient()
    private val jsonMediaType = "application/json".toMediaType()

    @Throws(IOException::class)
    fun pair(brokerBaseUrl: String, pairingToken: String, deviceName: String): PairingResult {
        val body = JSONObject().apply {
            put("token", pairingToken)
            put("deviceName", deviceName)
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
                deviceToken = json.getString("deviceToken")
            )
        }
    }
}
