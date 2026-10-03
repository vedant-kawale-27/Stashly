/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

package com.stashly.app

import android.util.Base64
import android.util.Log
import android.content.Context
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.min
import kotlin.math.pow

/**
 * Owns the phone's single persistent connection to the broker and speaks the
 * protocol described in the broker's `ws/deviceHub.ts`:
 *
 *   Phone -> Broker: hello, file_sync, fetch_result, upload_result, sync_result
 *   Broker -> Phone: fetch_request, upload_request, sync_request
 *
 * Reconnects with capped exponential backoff whenever the socket drops —
 * this is what makes "the phone doesn't need a public IP" work: it always
 * dials out, never waits for an inbound connection.
 */
class BrokerSocketClient(
    private val context: Context,
    private val brokerBaseUrl: String,
    private val deviceId: String,
    private val deviceToken: String,
    private val fileVault: FileVault,
    private val onStateChange: (State) -> Unit,
    private val onNodeRemoved: (reason: String) -> Unit = {},
    private val onClientRemoved: (userId: String) -> Unit = {},
    private val onClientPresence: (userId: String, online: Boolean) -> Unit = { _, _ -> }
) {
    enum class State { CONNECTING, ONLINE, OFFLINE }

    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    private var socket: WebSocket? = null
    private var reconnectAttempt = 0
    private var stopped = false
    private val cancelledRequests = ConcurrentHashMap.newKeySet<String>()

    private fun sendDeviceHello(targetSocket: WebSocket) {
        val stat = android.os.StatFs(android.os.Environment.getExternalStorageDirectory().path)
        val battery = runCatching {
            val manager = context.getSystemService(Context.BATTERY_SERVICE) as android.os.BatteryManager
            manager.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY)
        }.getOrNull()
        val hello = JSONObject().apply {
            put("type", "hello")
            put("deviceId", deviceId)
            put("modelName", "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}".trim())
            put("modelNumber", android.os.Build.DEVICE)
            put("androidVersion", android.os.Build.VERSION.RELEASE ?: "Unknown")
            put("osVersion", android.os.Build.VERSION.RELEASE ?: "Unknown")
            put("appVersion", runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull() ?: "Unknown")
            put("storageTotalMb", (stat.totalBytes / (1024L * 1024L)).coerceAtMost(Int.MAX_VALUE.toLong()))
            put("storageFreeMb", (stat.availableBytes / (1024L * 1024L)).coerceAtMost(Int.MAX_VALUE.toLong()))
            if (battery != null && battery in 0..100) put("batteryLevel", battery)
        }
        targetSocket.send(hello.toString())
    }

    fun start() {
        stopped = false
        connect()
    }

    fun stop(clearRemoteFiles: Boolean = false) {
        stopped = true
        if (clearRemoteFiles) {
            socket?.send(JSONObject().put("type", "node_stop").toString())
        }
        socket?.close(1000, "client_stopping")
        socket = null
    }

    /** Call after any local file change to push fresh metadata to the broker. */
    fun pushFileSync(syncRequestId: String? = null): Boolean {
        try {
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
                        // thumbnailBase64 is NOT sent during sync — thumbnails are requested on-demand
                    }
                )
            }
            send(JSONObject().apply {
                put("type", "file_sync")
                put("files", filesJson)
                if (!syncRequestId.isNullOrEmpty()) put("syncRequestId", syncRequestId)
            })
            Log.i(TAG, "Sent file index to broker: ${entries.size} entries")
            return true
        } catch (error: Exception) {
            Log.e(TAG, "Could not scan and sync Android storage", error)
            return false
        }
    }

    private fun connect() {
        if (stopped) return
        onStateChange(State.CONNECTING)

        val wsUrl = brokerBaseUrl
            .replaceFirst("https://", "wss://")
            .replaceFirst("http://", "ws://")
            .trimEnd('/') + "/ws/device"

        val request = Request.Builder()
            .url(wsUrl)
            .addHeader("Authorization", "Bearer $deviceToken")
            .build()
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
            sendDeviceHello(webSocket)
            Thread {
                while (!stopped && socket === webSocket) {
                    Thread.sleep(60_000)
                    if (!stopped && socket === webSocket) sendDeviceHello(webSocket)
                }
            }.start()
            Thread {
                pushFileSync()
                Thread.sleep(3_000)
                if (!stopped && socket === webSocket) pushFileSync()
            }.start()
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val msg = try {
                JSONObject(text)
            } catch (e: Exception) {
                Log.w(TAG, "Malformed message from broker: $text")
                return
            }

            when (msg.optString("type")) {
                "client_unlinked" -> onClientRemoved(msg.optString("userId"))
                "client_presence" -> onClientPresence(msg.optString("userId"), msg.optBoolean("online", false))
                "node_unlinked" -> {
                    val reason = msg.optString("reason").ifEmpty { "Node removed from web dashboard" }
                    Log.w(TAG, "Broker notified node_unlinked: $reason")
                    stopped = true
                    socket?.close(1000, "node_unlinked")
                    socket = null
                    onStateChange(State.OFFLINE)
                    onNodeRemoved(reason)
                }
                "fetch_request" -> handleFetchRequest(msg)
                "fetch_chunk" -> handleFetchChunk(msg)
                "thumbnail_request" -> handleThumbnailRequest(msg)
                "cancel_request" -> cancelledRequests.add(msg.optString("requestId"))
                "upload_request" -> handleUploadRequest(msg)
                "sync_request" -> handleSyncRequest(msg)
                "delete_request" -> handleDeleteRequest(msg)
                "trash_request" -> handleTrashRequest(msg)
                "folder_request" -> handleFolderRequest(msg)
                else -> Log.d(TAG, "Unhandled message type: ${msg.optString("type")}")
            }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            if (stopped) return
            Log.w(TAG, "Socket failure: ${t.message}")
            if (response?.code == 401 || response?.code == 404) {
                Log.w(TAG, "Socket rejected by broker (HTTP ${response.code}) — node unlinked or invalid token")
                stopped = true
                onStateChange(State.OFFLINE)
                onNodeRemoved("Device token rejected (HTTP ${response.code})")
                return
            }
            onStateChange(State.OFFLINE)
            scheduleReconnect()
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            if (stopped) return
            if (code == 4004 || reason.contains("re-pair", ignoreCase = true) || reason.contains("unlinked", ignoreCase = true)) {
                Log.w(TAG, "Device connection closed by broker (unlinked/deleted): $reason (code $code)")
                stopped = true
                onStateChange(State.OFFLINE)
                onNodeRemoved(reason)
                return
            }
            onStateChange(State.OFFLINE)
            if (!stopped) scheduleReconnect()
        }
    }

    private fun handleFetchRequest(msg: JSONObject) {
        val requestId = msg.getString("requestId")
        val path = msg.getString("path")
        val reply = JSONObject().apply {
            put("type", "fetch_result")
            put("requestId", requestId)
        }
        try {
            val ciphertext = fileVault.getCiphertext(path)
            if (ciphertext != null) {
                reply.put("ok", true)
                reply.put("dataBase64", Base64.encodeToString(ciphertext, Base64.NO_WRAP))
            } else {
                reply.put("ok", false)
                reply.put("error", "File not found on device: $path")
            }
        } catch (e: Exception) {
            Log.w(TAG, "Error fetching file: $path", e)
            reply.put("ok", false)
            reply.put("error", e.message ?: "Failed to read file on device")
        }
        send(reply)
    }

    /**
     * Handles chunked file fetch requests from the broker. Reads a specific
     * byte range from the file, encrypts it independently, and sends the
     * result as a binary WebSocket frame to avoid base64 overhead.
     *
     * Binary frame format: [36-byte requestId UTF-8][1-byte type (0x01=chunk)][1-byte status (1=ok, 0=error)][encrypted chunk bytes]
     */
    private fun handleFetchChunk(msg: JSONObject) {
        val requestId = msg.getString("requestId")
        if (cancelledRequests.remove(requestId)) return
        val path = msg.getString("path")
        val offset = msg.optLong("offset", 0)
        val length = msg.optInt("length", 1024 * 1024)

        try {
            val encryptedChunk = fileVault.getChunkCiphertext(path, offset, length)
            if (cancelledRequests.remove(requestId)) return
            val requestIdBytes = requestId.toByteArray(Charsets.UTF_8)
            if (encryptedChunk != null) {
                // Build binary frame: [36-byte requestId][0x01 = chunk type][0x01 = ok][encrypted data]
                val frame = ByteArray(38 + encryptedChunk.size)
                System.arraycopy(requestIdBytes, 0, frame, 0, minOf(requestIdBytes.size, 36))
                frame[36] = 1 // type: chunk
                frame[37] = 1 // status: ok
                System.arraycopy(encryptedChunk, 0, frame, 38, encryptedChunk.size)
                socket?.send(frame.toByteString())
            } else {
                // Send error frame: [36-byte requestId][0x01 = chunk type][0x00 = error]
                val frame = ByteArray(38)
                System.arraycopy(requestIdBytes, 0, frame, 0, minOf(requestIdBytes.size, 36))
                frame[36] = 1 // type: chunk
                frame[37] = 0 // status: error
                socket?.send(frame.toByteString())
            }
        } catch (e: Exception) {
            Log.w(TAG, "Chunk fetch failed for $path offset=$offset", e)
            val requestIdBytes = requestId.toByteArray(Charsets.UTF_8)
            val frame = ByteArray(38)
            System.arraycopy(requestIdBytes, 0, frame, 0, minOf(requestIdBytes.size, 36))
            frame[36] = 1 // type: chunk
            frame[37] = 0 // status: error
            socket?.send(frame.toByteString())
        }
    }

    /**
     * Handles on-demand thumbnail requests from the broker. Generates the thumbnail,
     * encrypts it with the file's DEK, and sends as a binary WS frame.
     *
     * Binary frame format: [36-byte requestId UTF-8][1-byte type (0x02=thumbnail)][1-byte status (1=ok, 0=error)][encrypted thumbnail]
     */
    private fun handleThumbnailRequest(msg: JSONObject) {
        val requestId = msg.getString("requestId")
        if (cancelledRequests.remove(requestId)) return
        val path = msg.getString("path")

        try {
            val encryptedThumb = fileVault.getEncryptedThumbnail(path)
            if (cancelledRequests.remove(requestId)) return
            val requestIdBytes = requestId.toByteArray(Charsets.UTF_8)
            if (encryptedThumb != null) {
                // Build binary frame: [36-byte requestId][0x02 = thumbnail type][0x01 = ok][encrypted thumb]
                val frame = ByteArray(38 + encryptedThumb.size)
                System.arraycopy(requestIdBytes, 0, frame, 0, minOf(requestIdBytes.size, 36))
                frame[36] = 2 // type: thumbnail
                frame[37] = 1 // status: ok
                System.arraycopy(encryptedThumb, 0, frame, 38, encryptedThumb.size)
                socket?.send(frame.toByteString())
            } else {
                // Send error frame
                val frame = ByteArray(38)
                System.arraycopy(requestIdBytes, 0, frame, 0, minOf(requestIdBytes.size, 36))
                frame[36] = 2 // type: thumbnail
                frame[37] = 0 // status: error
                socket?.send(frame.toByteString())
            }
        } catch (e: Exception) {
            Log.w(TAG, "Thumbnail generation failed for $path", e)
            val requestIdBytes = requestId.toByteArray(Charsets.UTF_8)
            val frame = ByteArray(38)
            System.arraycopy(requestIdBytes, 0, frame, 0, minOf(requestIdBytes.size, 36))
            frame[36] = 2 // type: thumbnail
            frame[37] = 0 // status: error
            socket?.send(frame.toByteString())
        }
    }

    private fun handleUploadRequest(msg: JSONObject) {
        val requestId = msg.getString("requestId")
        val path = msg.getString("path")
        val reply = JSONObject().apply {
            put("type", "upload_result")
            put("requestId", requestId)
        }
        try {
            val encrypted = Base64.decode(msg.getString("dataBase64"), Base64.NO_WRAP)
            fileVault.writeUploadedFile(path, encrypted, msg.getString("encryptedDek"))
            reply.put("ok", true)
            send(reply)
            pushFileSync()
        } catch (error: Exception) {
            Log.w(TAG, "Upload failed for $path", error)
            reply.put("ok", false)
            reply.put("error", error.message ?: "Upload failed on device")
            send(reply)
        }
    }

    private fun handleDeleteRequest(msg: JSONObject) {
        val requestId = msg.getString("requestId")
        val path = msg.getString("path")
        val permanent = msg.optBoolean("permanent", false)
        val reply = JSONObject().apply {
            put("type", "delete_result")
            put("requestId", requestId)
        }

        try {
            val deleted = fileVault.deleteFile(path, permanent = permanent)
            if (deleted) {
                reply.put("ok", true)
                send(reply)
                pushFileSync()
            } else {
                reply.put("ok", false)
                reply.put("error", "File could not be deleted from storage")
                send(reply)
            }
        } catch (error: Exception) {
            Log.w(TAG, "Delete failed for $path", error)
            reply.put("ok", false)
            reply.put("error", error.message ?: "Delete failed on device")
            send(reply)
        }
    }

    private fun handleTrashRequest(msg: JSONObject) {
        val requestId = msg.getString("requestId")
        val path = msg.getString("path")
        val action = msg.optString("action", "trash")
        val reply = JSONObject().apply {
            put("type", "trash_result")
            put("requestId", requestId)
        }

        try {
            val ok = when (action) {
                "trash" -> fileVault.moveToTrash(path)
                "restore" -> fileVault.restoreFromTrash(path)
                "permanent" -> fileVault.permanentDelete(path)
                else -> fileVault.moveToTrash(path)
            }
            reply.put("ok", ok)
            if (!ok) reply.put("error", "Recycle bin operation failed on device")
            send(reply)
            if (ok) pushFileSync()
        } catch (error: Exception) {
            Log.w(TAG, "Recycle bin operation failed for $path ($action)", error)
            reply.put("ok", false)
            reply.put("error", error.message ?: "Recycle bin operation failed on device")
            send(reply)
        }
    }

    private fun handleFolderRequest(msg: JSONObject) {
        val requestId = msg.getString("requestId")
        val operation = msg.optString("operation")
        val reply = JSONObject().put("type", "folder_result").put("requestId", requestId)
        try {
            val ok = when (operation) {
                "create" -> fileVault.createFolder(msg.getString("path"))
                "move", "rename" -> fileVault.movePath(msg.getString("source"), msg.getString("destination"))
                else -> false
            }
            reply.put("ok", ok)
            if (!ok) reply.put("error", "Folder operation failed on device")
        } catch (error: Exception) {
            reply.put("ok", false).put("error", error.message ?: "Folder operation failed")
        }
        send(reply)
        if (reply.optBoolean("ok")) pushFileSync()
    }

    private fun handleSyncRequest(msg: JSONObject) {
        val requestId = msg.getString("requestId")
        if (!pushFileSync(requestId)) {
            send(JSONObject().apply {
                put("type", "sync_result")
                put("requestId", requestId)
                put("ok", false)
                put("error", "Android storage scan failed")
            })
        }
    }

    companion object {
        private const val TAG = "BrokerSocketClient"
    }
}
