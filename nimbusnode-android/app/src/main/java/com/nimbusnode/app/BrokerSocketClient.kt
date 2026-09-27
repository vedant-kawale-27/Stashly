package com.nimbusnode.app

import android.util.Base64
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import kotlin.math.min
import kotlin.math.pow

/**
 * Owns the phone's single persistent connection to the broker and speaks the
 * protocol described in the broker's `ws/deviceHub.ts`:
 *
 *   Phone -> Broker: hello, file_sync, fetch_result
 *   Broker -> Phone: fetch_request
 *
 * Reconnects with capped exponential backoff whenever the socket drops —
 * this is what makes "the phone doesn't need a public IP" work: it always
 * dials out, never waits for an inbound connection.
 */
class BrokerSocketClient(
    private val brokerBaseUrl: String,
    private val deviceId: String,
    private val deviceToken: String,
    private val fileVault: FileVault,
    private val onStateChange: (State) -> Unit
) {
    enum class State { CONNECTING, ONLINE, OFFLINE }

    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    private var socket: WebSocket? = null
    private var reconnectAttempt = 0
    private var stopped = false

    fun start() {
        stopped = false
        connect()
    }

    fun stop() {
        stopped = true
        socket?.close(1000, "client_stopping")
        socket = null
    }

    /** Call after any local file change to push fresh metadata to the broker. */
    fun pushFileSync() {
        val entries = fileVault.scanAndSync()
        val filesJson = JSONArray()
        entries.forEach { e ->
            filesJson.put(
                JSONObject().apply {
                    put("path", e.path)
                    put("name", e.name)
                    put("sizeBytes", e.sizeBytes)
                    put("contentHash", e.contentHash)
                    put("mimeType", e.mimeType)
                    put("encryptedDek", e.encryptedDek)
                }
            )
        }
        send(JSONObject().apply {
            put("type", "file_sync")
            put("files", filesJson)
        })
    }

    private fun connect() {
        if (stopped) return
        onStateChange(State.CONNECTING)

        val wsUrl = brokerBaseUrl
            .replaceFirst("https://", "wss://")
            .replaceFirst("http://", "ws://")
            .trimEnd('/') + "/ws/device?token=$deviceToken"

        val request = Request.Builder().url(wsUrl).build()
        socket = client.newWebSocket(request, listener)
    }

    private fun scheduleReconnect() {
        if (stopped) return
        reconnectAttempt++
        val delaySeconds = min(30.0, 2.0.pow(reconnectAttempt)).toLong()
        Log.i(TAG, "Reconnecting in ${delaySeconds}s (attempt $reconnectAttempt)")
        Thread {
            Thread.sleep(delaySeconds * 1000)
            connect()
        }.start()
    }

    private fun send(json: JSONObject) {
        socket?.send(json.toString())
    }

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            reconnectAttempt = 0
            onStateChange(State.ONLINE)
            send(JSONObject().apply {
                put("type", "hello")
                put("deviceId", deviceId)
            })
            pushFileSync()
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val msg = try {
                JSONObject(text)
            } catch (e: Exception) {
                Log.w(TAG, "Malformed message from broker: $text")
                return
            }

            when (msg.optString("type")) {
                "fetch_request" -> handleFetchRequest(msg)
                else -> Log.d(TAG, "Unhandled message type: ${msg.optString("type")}")
            }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            Log.w(TAG, "Socket failure: ${t.message}")
            onStateChange(State.OFFLINE)
            scheduleReconnect()
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            onStateChange(State.OFFLINE)
            if (!stopped) scheduleReconnect()
        }
    }

    private fun handleFetchRequest(msg: JSONObject) {
        val requestId = msg.getString("requestId")
        val path = msg.getString("path")
        val ciphertext = fileVault.getCiphertext(path)

        val reply = JSONObject().apply {
            put("type", "fetch_result")
            put("requestId", requestId)
            if (ciphertext != null) {
                put("ok", true)
                put("dataBase64", Base64.encodeToString(ciphertext, Base64.NO_WRAP))
            } else {
                put("ok", false)
                put("error", "File not found on device: $path")
            }
        }
        send(reply)
    }

    companion object {
        private const val TAG = "BrokerSocketClient"
    }
}
