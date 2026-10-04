/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

package com.stashly.app

import android.bluetooth.BluetoothManager
import android.content.Context

/**
 * Owns the lifecycle and construction of the BLE key-sharing session,
 * plus the permission-check and Bluetooth-availability orchestration.
 *
 * Takes a [Context] for BLE system-service access (not for UI — the
 * Activity passes dialog/toast callbacks separately).
 */
class BluetoothPairingCoordinator(private val context: Context) {
    private var server: BleKeyShareServer? = null

    /** Bluetooth availability states. */
    enum class BluetoothState { NOT_AVAILABLE, DISABLED, READY }

    /**
     * Return the list of BLE permissions that have NOT been granted yet.
     * @param isGranted check function — typically wraps checkSelfPermission.
     */
    fun getNeededPermissions(isGranted: (String) -> Boolean): Array<String> {
        return SystemPermissionCoordinator.bluetoothPermissions()
            .filter { !isGranted(it) }
            .toTypedArray()
    }

    /** Check whether the Bluetooth adapter is available and enabled. */
    fun checkBluetoothState(): BluetoothState {
        val adapter = (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
            ?: return BluetoothState.NOT_AVAILABLE
        return if (adapter.isEnabled) BluetoothState.READY else BluetoothState.DISABLED
    }

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
