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
import java.util.UUID
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

    @Volatile
    private var socket: WebSocket? = null
    @Volatile
    private var currentState: State = State.OFFLINE
    @Volatile
    private var stopped = false
    private val connectLock = Any()
    private val scheduler = java.util.concurrent.Executors.newSingleThreadScheduledExecutor()
    private var reconnectFuture: java.util.concurrent.ScheduledFuture<*>? = null
    private var reconnectAttempt = 0
    private val cancelledRequests = ConcurrentHashMap.newKeySet<String>()
    private data class IncomingUpload(val path: String, val encryptedDek: String, val totalBytes: Long, val totalChunks: Int, val chunks: java.util.concurrent.ConcurrentHashMap<Int, ByteArray> = java.util.concurrent.ConcurrentHashMap())
    private val incomingUploads = ConcurrentHashMap<String, IncomingUpload>()
    private val workerPool = java.util.concurrent.Executors.newFixedThreadPool(4)
    private val syncLock = Any()
    @Volatile
    private var isSyncing = false

    private fun sendDeviceHello(targetSocket: WebSocket) {
        val stat = android.os.StatFs(android.os.Environment.getExternalStorageDirectory().path)
        val battery = runCatching {
            val manager = context.getSystemService(Context.BATTERY_SERVICE) as android.os.BatteryManager
            manager.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY)
        }.getOrNull()

        var sdcardTotalMb: Long? = null
        var sdcardFreeMb: Long? = null
        var sdcardMounted = false

        val sdcardAccessEnabled = SecureStorage(context).sdcardAccessEnabled
        if (sdcardAccessEnabled) {
            try {
                val removableFile = StorageUtils.getMountedSdCardFile(context)
                if (removableFile != null) {
                    val sdStat = android.os.StatFs(removableFile.path)
                    sdcardMounted = true
                    sdcardTotalMb = (sdStat.totalBytes / (1024L * 1024L)).coerceAtMost(Int.MAX_VALUE.toLong())
                    sdcardFreeMb = (sdStat.availableBytes / (1024L * 1024L)).coerceAtMost(Int.MAX_VALUE.toLong())
                }
            } catch (_: Exception) {}
        }

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
            put("sdcardMounted", sdcardMounted)
            if (sdcardTotalMb != null) put("sdcardTotalMb", sdcardTotalMb)
            if (sdcardFreeMb != null) put("sdcardFreeMb", sdcardFreeMb)
            if (battery != null && battery in 0..100) put("batteryLevel", battery)
        }
        targetSocket.send(hello.toString())
    }

    fun start() {
        synchronized(connectLock) {
            stopped = false
            cancelReconnect()
            if (currentState == State.ONLINE && socket != null) {
                Log.d(TAG, "start() called but already ONLINE with active socket")
                return
            }
            if (currentState == State.CONNECTING && socket != null) {
                Log.d(TAG, "start() called but already CONNECTING with active socket")
                return
            }
            connectLocked()
        }
    }

    fun stop(clearRemoteFiles: Boolean = false) {
        synchronized(connectLock) {
            stopped = true
            cancelReconnect()
            currentState = State.OFFLINE
            val activeSocket = socket
            socket = null
            if (activeSocket != null) {
                try {
                    activeSocket.send(JSONObject().put("type", "sharing_pause").toString())
                    if (clearRemoteFiles) {
                        activeSocket.send(JSONObject().put("type", "node_stop").toString())
                    }
                    activeSocket.close(1000, "client_stopping")
                } catch (_: Exception) {
                    activeSocket.cancel()
                }
            }
            onStateChange(State.OFFLINE)
        }
    }

    private fun sendDeltaUpdate(entry: FileSyncEntry) {
        try {
            send(JSONObject().apply {
                put("type", "file_delta")
                put("action", "update")
                put("file", JSONObject().apply {
                    put("path", entry.path)
                    put("name", entry.name)
                    put("sizeBytes", entry.sizeBytes)
                    put("contentHash", entry.contentHash)
                    put("mimeType", entry.mimeType)
                    put("encryptedDek", entry.encryptedDek)
                })
            })
        } catch (e: Exception) {
            Log.w(TAG, "Failed sending delta update: ${e.message}")
        }
    }

    private fun sendDeltaTrash(path: String) {
        try {
            send(JSONObject().apply {
                put("type", "file_delta")
                put("action", "trash")
                put("file", JSONObject().apply {
                    put("path", path)
                })
            })
        } catch (e: Exception) {
            Log.w(TAG, "Failed sending delta trash: ${e.message}")
        }
    }

    private fun sendDeltaRestore(path: String) {
        try {
            send(JSONObject().apply {
                put("type", "file_delta")
                put("action", "restore")
                put("file", JSONObject().apply {
                    put("path", path)
                })
            })
        } catch (e: Exception) {
            Log.w(TAG, "Failed sending delta restore: ${e.message}")
        }
    }

    private fun sendDeltaPermanentDelete(path: String) {
        try {
            send(JSONObject().apply {
                put("type", "file_delta")
                put("action", "permanent_delete")
                put("file", JSONObject().apply {
                    put("path", path)
                })
            })
        } catch (e: Exception) {
            Log.w(TAG, "Failed sending delta permanent delete: ${e.message}")
        }
    }

    /** Call after any local file change to push fresh metadata to the broker. */
    fun pushFileSync(syncRequestId: String? = null): Boolean {
        synchronized(syncLock) {
            if (isSyncing) return true
            isSyncing = true
        }
        return try {
            val entries = fileVault.scanAndSync()
            val syncId = UUID.randomUUID().toString()
            val batchSize = 500
            val totalChunks = maxOf(1, (entries.size + batchSize - 1) / batchSize)
            entries.chunked(batchSize).forEachIndexed { chunkIndex, chunk ->
                val batchJson = JSONArray()
                chunk.forEach { e ->
                    batchJson.put(
                        JSONObject().apply {
                            put("path", e.path)
                            put("name", e.name)
                            put("sizeBytes", e.sizeBytes)
                            put("contentHash", e.contentHash)
                            put("mimeType", e.mimeType)
                            put("encryptedDek", e.encryptedDek)
                            if (e.isTrashed) put("isTrashed", true)
                        }
                    )
                }
                send(JSONObject().apply {
                    put("type", "file_sync_chunk")
                    put("syncId", syncId)
                    put("chunkIndex", chunkIndex)
                    put("totalChunks", totalChunks)
                    put("files", batchJson)
                    if (!syncRequestId.isNullOrEmpty()) put("syncRequestId", syncRequestId)
                })
                Thread.sleep(15) // Gentle delay to avoid socket buffer congestion
            }
            Log.i(TAG, "Sent file index to broker: ${entries.size} entries")
            true
        } catch (error: Exception) {
            Log.e(TAG, "Could not scan and sync Android storage", error)
            false
        } finally {
            synchronized(syncLock) {
                isSyncing = false
            }
        }
    }

    private fun cancelReconnect() {
        reconnectFuture?.cancel(true)
        reconnectFuture = null
    }

    private fun connectLocked() {
        if (stopped) return
        cancelReconnect()

        // Clean up and cancel any previous socket before opening a new one
        val oldSocket = socket
        socket = null
        oldSocket?.cancel()

        currentState = State.CONNECTING
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
        synchronized(connectLock) {
            if (stopped) return
            cancelReconnect()
            reconnectAttempt++
            val delaySeconds = min(30.0, 2.0.pow(reconnectAttempt)).toLong()
            Log.i(TAG, "Reconnecting in ${delaySeconds}s (attempt $reconnectAttempt)")
            reconnectFuture = scheduler.schedule({
                synchronized(connectLock) {
                    if (!stopped && (currentState != State.ONLINE || socket == null)) {
                        connectLocked()
                    }
                }
            }, delaySeconds, TimeUnit.SECONDS)
        }
    }

    private fun send(json: JSONObject) {
        socket?.send(json.toString())
    }

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            synchronized(connectLock) {
                if (stopped || socket !== webSocket) {
                    Log.d(TAG, "Ignoring onOpen for stale or stopped socket")
                    webSocket.cancel()
                    return
                }
                reconnectAttempt = 0
                cancelReconnect()
                currentState = State.ONLINE
                onStateChange(State.ONLINE)
            }
            sendDeviceHello(webSocket)
            workerPool.execute {
                while (!stopped && socket === webSocket) {
                    try {
                        Thread.sleep(60_000)
                        if (!stopped && socket === webSocket) sendDeviceHello(webSocket)
                    } catch (_: InterruptedException) {
                        break
                    }
                }
            }
            workerPool.execute {
                pushFileSync()
            }
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (webSocket !== socket) {
                Log.d(TAG, "Ignoring message from stale socket")
                return
            }
            workerPool.execute {
                val msg = try {
                    JSONObject(text)
                } catch (e: Exception) {
                    Log.w(TAG, "Malformed message from broker: $text")
                    return@execute
                }

                when (msg.optString("type")) {
                    "client_unlinked" -> onClientRemoved(msg.optString("userId"))
                    "client_presence" -> onClientPresence(msg.optString("userId"), msg.optBoolean("online", false))
                    "node_unlinked" -> {
                        val reason = msg.optString("reason").ifEmpty { "Node removed from web dashboard" }
                        Log.w(TAG, "Broker notified node_unlinked: $reason")
                        synchronized(connectLock) {
                            stopped = true
                            cancelReconnect()
                            currentState = State.OFFLINE
                            val s = socket
                            socket = null
                            s?.close(1000, "node_unlinked")
                            onStateChange(State.OFFLINE)
                        }
                        onNodeRemoved(reason)
                    }
                    "fetch_request" -> handleFetchRequest(msg)
                    "fetch_chunk" -> handleFetchChunk(msg)
                    "thumbnail_request" -> handleThumbnailRequest(msg)
                    "cancel_request" -> cancelledRequests.add(msg.optString("requestId"))
                    "upload_request" -> handleUploadRequest(msg)
                    "upload_start" -> handleUploadStart(msg)
                    "upload_chunk" -> handleUploadChunk(msg)
                    "upload_complete" -> handleUploadComplete(msg)
                    "sync_request" -> handleSyncRequest(msg)
                    "delete_request" -> handleDeleteRequest(msg)
                    "trash_request" -> handleTrashRequest(msg)
                    "folder_request" -> handleFolderRequest(msg)
                    else -> Log.d(TAG, "Unhandled message type: ${msg.optString("type")}")
                }
            }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            synchronized(connectLock) {
                if (stopped || webSocket !== socket) {
                    Log.d(TAG, "Ignoring onFailure for stale or stopped socket: ${t.message}")
                    return
                }
                Log.w(TAG, "Socket failure: ${t.message}")
                if (response?.code == 401 || response?.code == 404) {
                    Log.w(TAG, "Socket rejected by broker (HTTP ${response.code}) — node unlinked or invalid token")
                    stopped = true
                    cancelReconnect()
                    socket = null
                    currentState = State.OFFLINE
                    onStateChange(State.OFFLINE)
                    onNodeRemoved("Device token rejected (HTTP ${response.code})")
                    return
                }
                currentState = State.OFFLINE
                onStateChange(State.OFFLINE)
                scheduleReconnect()
            }
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            synchronized(connectLock) {
                if (stopped || webSocket !== socket) {
                    Log.d(TAG, "Ignoring onClosed for stale or stopped socket: $reason")
                    return
                }
                if (code == 4004 || reason.contains("re-pair", ignoreCase = true) || reason.contains("unlinked", ignoreCase = true)) {
                    Log.w(TAG, "Device connection closed by broker (unlinked/deleted): $reason (code $code)")
                    stopped = true
                    cancelReconnect()
                    socket = null
                    currentState = State.OFFLINE
                    onStateChange(State.OFFLINE)
                    onNodeRemoved(reason)
                    return
                }
                currentState = State.OFFLINE
                onStateChange(State.OFFLINE)
                scheduleReconnect()
            }
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
            val entry = fileVault.writeUploadedFile(path, encrypted, msg.getString("encryptedDek"))
            reply.put("ok", true)
            send(reply)
            sendDeltaUpdate(entry)
        } catch (error: Exception) {
            Log.w(TAG, "Upload failed for $path", error)
            reply.put("ok", false)
            reply.put("error", error.message ?: "Upload failed on device")
            send(reply)
        }
    }

    private fun handleUploadStart(msg: JSONObject) {
        val uploadId = msg.getString("uploadId")
        incomingUploads[uploadId] = IncomingUpload(msg.getString("path"), msg.getString("encryptedDek"), msg.getLong("totalBytes"), msg.getInt("totalChunks"))
        send(JSONObject().apply { put("type", "upload_result"); put("requestId", msg.getString("requestId")); put("ok", true) })
    }

    private fun handleUploadChunk(msg: JSONObject) {
        val upload = incomingUploads[msg.getString("uploadId")]
        val index = msg.getInt("chunkIndex")
        val ok = upload != null && index >= 0 && index < upload.totalChunks
        if (ok) upload!!.chunks.putIfAbsent(index, Base64.decode(msg.getString("dataBase64"), Base64.NO_WRAP))
        send(JSONObject().apply {
            put("type", "upload_result"); put("requestId", msg.getString("requestId")); put("ok", ok)
            if (!ok) put("error", "Unknown or invalid upload chunk")
        })
    }

    private fun handleUploadComplete(msg: JSONObject) {
        val upload = incomingUploads.remove(msg.getString("uploadId"))
        val reply = JSONObject().apply { put("type", "upload_result"); put("requestId", msg.getString("requestId")) }
        try {
            require(upload != null && upload.chunks.size == upload.totalChunks)
            val chunks = (0 until upload.totalChunks).map { upload.chunks[it] ?: error("Missing upload chunk $it") }
            val entry = fileVault.writeUploadedChunks(upload.path, chunks, upload.encryptedDek, upload.totalBytes)
            reply.put("ok", true)
            send(reply)
            sendDeltaUpdate(entry)
        } catch (error: Exception) {
            reply.put("ok", false).put("error", error.message ?: "Chunked upload failed on device")
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
                if (permanent) sendDeltaPermanentDelete(path)
                else sendDeltaTrash(path)
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
            if (ok) {
                when (action) {
                    "trash" -> sendDeltaTrash(path)
                    "restore" -> sendDeltaRestore(path)
                    "permanent" -> sendDeltaPermanentDelete(path)
                }
            }
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
