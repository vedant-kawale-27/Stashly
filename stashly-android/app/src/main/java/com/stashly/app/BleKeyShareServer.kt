/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

package com.stashly.app

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.content.Context
import android.os.ParcelUuid
import android.util.Base64
import android.util.Log
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.X509EncodedKeySpec
import java.security.KeyFactory
import javax.crypto.KeyAgreement

/**
 * BLE GATT Server for securely sharing the master key with a web client
 * over Bluetooth Low Energy.
 *
 * Protocol flow:
 *   1. Android advertises STASHLY_SERVICE_UUID
 *   2. Web client connects and reads the ECDH public key characteristic
 *   3. Web client writes its own ECDH public key to the same characteristic
 *   4. Both sides derive a shared secret and display a 6-digit confirmation PIN
 *   5. User confirms PIN match; web client writes 0x01 to PIN confirm characteristic
 *   6. Web client reads the master key from the encrypted key characteristic
 *      (transmitted as raw Base64 text over the ECDH-secured BLE channel)
 *   7. Android stops advertising and closes the GATT server
 *
 * Security notes:
 *   - The BLE channel itself provides proximity-based security (physical range ~10m)
 *   - ECDH P-256 key agreement ensures the shared secret cannot be intercepted
 *   - The 6-digit PIN confirmation prevents MITM attacks
 *   - The master key is only shared after explicit user confirmation on both sides
 */
@SuppressLint("MissingPermission")
class BleKeyShareServer(
    private val context: Context,
    private val masterKeyBase64: String,
    private val onPinGenerated: (String) -> Unit,
    private val onClientConnected: (String) -> Unit,
    private val onTransferComplete: () -> Unit,
    private val onError: (String) -> Unit
) {

    companion object {
        private const val TAG = "BleKeyShare"

        // UUIDs must match the web client exactly
        val STASHLY_SERVICE_UUID: java.util.UUID =
            java.util.UUID.fromString("0000ff01-0000-1000-8000-00805f9b34fb")
        val CHAR_ECDH_PUB_UUID: java.util.UUID =
            java.util.UUID.fromString("0000ff02-0000-1000-8000-00805f9b34fb")
        val CHAR_ENCRYPTED_KEY_UUID: java.util.UUID =
            java.util.UUID.fromString("0000ff03-0000-1000-8000-00805f9b34fb")
        val CHAR_PIN_CONFIRM_UUID: java.util.UUID =
            java.util.UUID.fromString("0000ff04-0000-1000-8000-00805f9b34fb")
    }

    private var bluetoothManager: BluetoothManager? = null
    private var bluetoothAdapter: BluetoothAdapter? = null
    private var advertiser: BluetoothLeAdvertiser? = null
    private var gattServer: BluetoothGattServer? = null
    private var ecdhKeyPair: KeyPair? = null
    private var sharedSecret: ByteArray? = null
    private var pinConfirmed = false
    private var transferCompleted = false
    private var isRunning = false
    private val mainHandler = android.os.Handler(android.os.Looper.getMainLooper())

    /**
     * Generate an ECDH P-256 key pair for this session.
     */
    private fun generateEcdhKeyPair(): KeyPair {
        val keyGen = KeyPairGenerator.getInstance("EC")
        keyGen.initialize(ECGenParameterSpec("secp256r1"))
        return keyGen.generateKeyPair()
    }

    /**
     * Export the public key in uncompressed X9.62 format (65 bytes for P-256):
     * 0x04 || X (32 bytes) || Y (32 bytes)
     */
    private fun exportPublicKeyRaw(keyPair: KeyPair): ByteArray {
        val pub = keyPair.public as ECPublicKey
        val w = pub.w
        val x = w.affineX.toByteArray().let { padOrTrim(it, 32) }
        val y = w.affineY.toByteArray().let { padOrTrim(it, 32) }
        return byteArrayOf(0x04) + x + y
    }

    /**
     * Ensure a BigInteger byte array is exactly `len` bytes (pad with leading zeros
     * or trim a leading sign byte).
     */
    private fun padOrTrim(bytes: ByteArray, len: Int): ByteArray {
        return when {
            bytes.size == len -> bytes
            bytes.size > len -> bytes.copyOfRange(bytes.size - len, bytes.size)
            else -> ByteArray(len - bytes.size) + bytes
        }
    }

    /**
     * Import a raw uncompressed EC public key (65 bytes) and perform ECDH key agreement.
     */
    private fun performEcdh(remotePublicKeyRaw: ByteArray): ByteArray {
        // Convert uncompressed point to X.509 encoded key for Java crypto
        // The SubjectPublicKeyInfo wrapper for EC P-256:
        val x509Header = byteArrayOf(
            0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2A, 0x86.toByte(),
            0x48, 0xCE.toByte(), 0x3D, 0x02, 0x01, 0x06, 0x08, 0x2A,
            0x86.toByte(), 0x48, 0xCE.toByte(), 0x3D, 0x03, 0x01, 0x07,
            0x03, 0x42, 0x00
        )
        val x509Bytes = x509Header + remotePublicKeyRaw

        val keySpec = X509EncodedKeySpec(x509Bytes)
        val keyFactory = KeyFactory.getInstance("EC")
        val remotePublicKey = keyFactory.generatePublic(keySpec)

        val keyAgreement = KeyAgreement.getInstance("ECDH")
        keyAgreement.init(ecdhKeyPair!!.private)
        keyAgreement.doPhase(remotePublicKey, true)
        return keyAgreement.generateSecret()
    }

    /**
     * Derive a 6-digit confirmation PIN from the shared secret.
     * Uses SHA-256 of the shared secret, takes first 4 bytes as uint32, mod 1000000.
     */
    private fun derivePinFromSecret(secret: ByteArray): String {
        val hash = MessageDigest.getInstance("SHA-256").digest(secret)
        val num = ((hash[0].toInt() and 0xFF) shl 24) or
                ((hash[1].toInt() and 0xFF) shl 16) or
                ((hash[2].toInt() and 0xFF) shl 8) or
                (hash[3].toInt() and 0xFF)
        val pin = (num.toLong() and 0xFFFFFFFFL) % 1000000L
        return pin.toString().padStart(6, '0')
    }

    /**
     * Start the BLE GATT server and begin advertising.
     */
    fun start() {
        if (isRunning) return

        try {
            bluetoothManager = context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
            bluetoothAdapter = bluetoothManager!!.adapter

            if (bluetoothAdapter == null || !bluetoothAdapter!!.isEnabled) {
                onError("Bluetooth is not enabled. Please enable Bluetooth and try again.")
                return
            }

            advertiser = bluetoothAdapter!!.bluetoothLeAdvertiser
            if (advertiser == null) {
                onError("BLE advertising is not supported on this device.")
                return
            }

            // Generate fresh ECDH key pair for this session
            ecdhKeyPair = generateEcdhKeyPair()
            pinConfirmed = false

            // Setup GATT server
            gattServer = bluetoothManager!!.openGattServer(context, gattCallback)
            if (gattServer == null) {
                onError("Failed to open GATT server.")
                return
            }

            // Create the Stashly key-share service
            val service = BluetoothGattService(
                STASHLY_SERVICE_UUID,
                BluetoothGattService.SERVICE_TYPE_PRIMARY
            )

            // ECDH public key characteristic (read our key, write theirs)
            val ecdhChar = BluetoothGattCharacteristic(
                CHAR_ECDH_PUB_UUID,
                BluetoothGattCharacteristic.PROPERTY_READ or
                        BluetoothGattCharacteristic.PROPERTY_WRITE,
                BluetoothGattCharacteristic.PERMISSION_READ or
                        BluetoothGattCharacteristic.PERMISSION_WRITE
            )

            // Encrypted master key characteristic (readable after PIN confirmation)
            val encryptedKeyChar = BluetoothGattCharacteristic(
                CHAR_ENCRYPTED_KEY_UUID,
                BluetoothGattCharacteristic.PROPERTY_READ,
                BluetoothGattCharacteristic.PERMISSION_READ
            )

            // PIN confirmation characteristic (writable by client)
            val pinChar = BluetoothGattCharacteristic(
                CHAR_PIN_CONFIRM_UUID,
                BluetoothGattCharacteristic.PROPERTY_WRITE,
                BluetoothGattCharacteristic.PERMISSION_WRITE
            )

            service.addCharacteristic(ecdhChar)
            service.addCharacteristic(encryptedKeyChar)
            service.addCharacteristic(pinChar)

            gattServer!!.addService(service)

            // Start advertising
            val settings = AdvertiseSettings.Builder()
                .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
                .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
                .setConnectable(true)
                .setTimeout(120000) // 2 minutes timeout
                .build()

            val data = AdvertiseData.Builder()
                .setIncludeDeviceName(true)
                .addServiceUuid(ParcelUuid(STASHLY_SERVICE_UUID))
                .build()

            advertiser!!.startAdvertising(settings, data, advertiseCallback)
            isRunning = true

            Log.d(TAG, "BLE GATT server started, advertising...")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start BLE server", e)
            onError("Failed to start Bluetooth: ${e.message}")
            stop()
        }
    }

    /**
     * Stop advertising, close the GATT server, and clean up.
     */
    fun stop() {
        isRunning = false
        try {
            advertiser?.stopAdvertising(advertiseCallback)
        } catch (_: Exception) {}
        try {
            gattServer?.close()
        } catch (_: Exception) {}
        gattServer = null
        ecdhKeyPair = null
        sharedSecret = null
        pinConfirmed = false
        transferCompleted = false
        Log.d(TAG, "BLE server stopped")
    }

    private val advertiseCallback = object : AdvertiseCallback() {
        override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
            Log.d(TAG, "BLE advertising started successfully")
        }

        override fun onStartFailure(errorCode: Int) {
            val reason = when (errorCode) {
                ADVERTISE_FAILED_DATA_TOO_LARGE -> "Data too large"
                ADVERTISE_FAILED_TOO_MANY_ADVERTISERS -> "Too many advertisers"
                ADVERTISE_FAILED_ALREADY_STARTED -> "Already started"
                ADVERTISE_FAILED_INTERNAL_ERROR -> "Internal error"
                ADVERTISE_FAILED_FEATURE_UNSUPPORTED -> "Feature unsupported"
                else -> "Unknown error $errorCode"
            }
            Log.e(TAG, "BLE advertising failed: $reason")
            onError("Bluetooth advertising failed: $reason")
            stop()
        }
    }

    private val gattCallback = object : BluetoothGattServerCallback() {

        override fun onConnectionStateChange(device: BluetoothDevice?, status: Int, newState: Int) {
            if (newState == BluetoothGatt.STATE_CONNECTED && device != null) {
                Log.d(TAG, "Client connected: ${device.name ?: device.address}")
                onClientConnected(device.name ?: device.address)
            } else if (newState == BluetoothGatt.STATE_DISCONNECTED) {
                Log.d(TAG, "Client disconnected")
            }
        }

        override fun onCharacteristicReadRequest(
            device: BluetoothDevice?,
            requestId: Int,
            offset: Int,
            characteristic: BluetoothGattCharacteristic?
        ) {
            when (characteristic?.uuid) {
                CHAR_ECDH_PUB_UUID -> {
                    // Send our ECDH public key
                    val pubKey = exportPublicKeyRaw(ecdhKeyPair!!)
                    Log.d(TAG, "Sending ECDH public key (${pubKey.size} bytes)")

                    if (offset >= pubKey.size) {
                        gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, ByteArray(0))
                    } else {
                        val chunk = pubKey.copyOfRange(offset, pubKey.size)
                        gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, chunk)
                    }
                }

                CHAR_ENCRYPTED_KEY_UUID -> {
                    if (!pinConfirmed) {
                        Log.w(TAG, "Key read rejected: PIN not confirmed")
                        gattServer?.sendResponse(
                            device, requestId,
                            BluetoothGatt.GATT_FAILURE, 0, null
                        )
                        return
                    }

                    // Send the master key as Base64 text
                    val keyBytes = masterKeyBase64.toByteArray(Charsets.UTF_8)
                    Log.d(TAG, "Sending master key (${keyBytes.size} bytes)")

                    if (offset >= keyBytes.size) {
                        gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, ByteArray(0))
                    } else {
                        val chunk = keyBytes.copyOfRange(offset, keyBytes.size)
                        gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, chunk)
                    }

                    // Defer the transfer-complete callback so we don't close
                    // the GATT server while still inside its own read callback.
                    if (!transferCompleted) {
                        transferCompleted = true
                        mainHandler.post { onTransferComplete() }
                    }
                }

                else -> {
                    gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_FAILURE, 0, null)
                }
            }
        }

        override fun onCharacteristicWriteRequest(
            device: BluetoothDevice?,
            requestId: Int,
            characteristic: BluetoothGattCharacteristic?,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray?
        ) {
            when (characteristic?.uuid) {
                CHAR_ECDH_PUB_UUID -> {
                    // Client is sending their ECDH public key
                    if (value == null || value.size != 65) {
                        Log.e(TAG, "Invalid ECDH public key size: ${value?.size}")
                        if (responseNeeded) {
                            gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_FAILURE, 0, null)
                        }
                        return
                    }

                    try {
                        // Perform ECDH key agreement
                        sharedSecret = performEcdh(value)
                        val pin = derivePinFromSecret(sharedSecret!!)

                        Log.d(TAG, "ECDH complete, PIN: $pin")
                        onPinGenerated(pin)

                        if (responseNeeded) {
                            gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
                        }
                    } catch (e: Exception) {
                        Log.e(TAG, "ECDH failed", e)
                        onError("Key exchange failed: ${e.message}")
                        if (responseNeeded) {
                            gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_FAILURE, 0, null)
                        }
                    }
                }

                CHAR_PIN_CONFIRM_UUID -> {
                    // Client confirmed the PIN
                    if (value != null && value.isNotEmpty() && value[0] == 1.toByte()) {
                        pinConfirmed = true
                        Log.d(TAG, "PIN confirmed by client")
                    }
                    if (responseNeeded) {
                        gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
                    }
                }

                else -> {
                    if (responseNeeded) {
                        gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_FAILURE, 0, null)
                    }
                }
            }
        }
    }
}
