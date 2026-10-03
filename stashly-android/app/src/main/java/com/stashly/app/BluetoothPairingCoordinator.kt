/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

package com.stashly.app

import android.content.Context

/** Owns the lifecycle and construction of the BLE key-sharing session. */
class BluetoothPairingCoordinator(private val context: Context) {
    private var server: BleKeyShareServer? = null

    fun createServer(
        masterKeyBase64: String,
        onPinGenerated: (String) -> Unit,
        onClientConnected: (String) -> Unit,
        onTransferComplete: () -> Unit,
        onError: (String) -> Unit,
    ): BleKeyShareServer {
        stop()
        return BleKeyShareServer(
            context = context,
            masterKeyBase64 = masterKeyBase64,
            onPinGenerated = onPinGenerated,
            onClientConnected = onClientConnected,
            onTransferComplete = onTransferComplete,
            onError = onError,
        ).also { server = it }
    }

    fun start(
        masterKeyBase64: String,
        onPinGenerated: (String) -> Unit,
        onClientConnected: (String) -> Unit,
        onTransferComplete: () -> Unit,
        onError: (String) -> Unit,
    ) {
        createServer(masterKeyBase64, onPinGenerated, onClientConnected, onTransferComplete, onError).start()
    }

    fun stop() {
        server?.stop()
        server = null
    }
}
