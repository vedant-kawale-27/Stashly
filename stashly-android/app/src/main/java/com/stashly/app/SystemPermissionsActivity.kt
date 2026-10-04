/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

package com.stashly.app

import android.Manifest
import android.bluetooth.BluetoothManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.PowerManager
import android.provider.Settings
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.NotificationManagerCompat
import com.stashly.app.databinding.ActivitySystemPermissionsBinding
import android.widget.Button

class SystemPermissionsActivity : AppCompatActivity() {
    private lateinit var binding: ActivitySystemPermissionsBinding
    private lateinit var cameraButton: Button
    private lateinit var bluetoothButton: Button
    private lateinit var notificationButton: Button
    private lateinit var batteryButton: Button
    private lateinit var storageButton: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivitySystemPermissionsBinding.inflate(layoutInflater)
        setContentView(binding.root)

        cameraButton = findViewById(R.id.btnCameraPermission)
        bluetoothButton = findViewById(R.id.btnBluetoothPermission)
        notificationButton = findViewById(R.id.btnNotificationPermission)
        batteryButton = findViewById(R.id.btnBatteryPermission)
        storageButton = findViewById(R.id.btnStoragePermission)

        binding.systemPermissionsToolbar.setNavigationOnClickListener { finish() }
        cameraButton.setOnClickListener { requestCamera() }
        bluetoothButton.setOnClickListener { requestBluetooth() }
        notificationButton.setOnClickListener { requestNotifications() }
        batteryButton.setOnClickListener { requestBatteryOptimization() }
        storageButton.setOnClickListener { requestStorageAccess() }
    }

    override fun onResume() {
        super.onResume()
        refreshPermissions()
    }

    private fun refreshPermissions() {
        val cameraGranted = checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
        setPermissionState(cameraButton, cameraGranted)

        val bluetoothGranted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED &&
                checkSelfPermission(Manifest.permission.BLUETOOTH_ADVERTISE) == PackageManager.PERMISSION_GRANTED
        } else {
            checkSelfPermission(Manifest.permission.BLUETOOTH) == PackageManager.PERMISSION_GRANTED
        }
        setPermissionState(bluetoothButton, bluetoothGranted)

        val notificationsEnabled = areNotificationsEnabled()
        setPermissionState(notificationButton, notificationsEnabled, getString(R.string.permission_not_granted))

        val batteryAllowed = (getSystemService(POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(packageName)
        setPermissionState(batteryButton, batteryAllowed)

        val storageAllowed = Build.VERSION.SDK_INT < Build.VERSION_CODES.R || Environment.isExternalStorageManager()
        setPermissionState(storageButton, storageAllowed)
    }

    private fun setPermissionState(button: Button, allowed: Boolean, deniedText: String = "Not granted") {
        button.text = if (allowed) getString(R.string.btn_granted) else deniedText
        button.isEnabled = true
    }

    private fun requestCamera() {
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.CAMERA), REQUEST_CAMERA)
        }
    }

    private fun requestBluetooth() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            requestPermissions(
                arrayOf(Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_ADVERTISE),
                REQUEST_BLUETOOTH
            )
        } else {
            val adapter = (getSystemService(BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
            if (adapter?.isEnabled == false) startActivity(Intent(Settings.ACTION_BLUETOOTH_SETTINGS))
        }
    }

    private fun requestNotifications() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATIONS)
            return
        }

        // The runtime permission can be granted while the app channel is still
        // blocked. In that case Android's notification settings are the only
        // place where the user can enable delivery again.
        if (!areNotificationsEnabled()) startActivity(notificationSettingsIntent())
    }

    private fun areNotificationsEnabled(): Boolean {
        if (!NotificationManagerCompat.from(this).areNotificationsEnabled()) return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = getSystemService(android.app.NotificationManager::class.java)
                .getNotificationChannel(NOTIFICATION_CHANNEL_ID)
            if (channel?.importance == android.app.NotificationManager.IMPORTANCE_NONE) return false
        }
        return true
    }

    private fun requestBatteryOptimization() {
        runCatching {
            startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:$packageName")
            })
        }.onFailure {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.parse("package:$packageName")
            })
        }
    }

    private fun requestStorageAccess() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION).apply {
                data = Uri.parse("package:$packageName")
            })
        }
    }

    private fun notificationSettingsIntent(): Intent {
        return Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
            putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_CAMERA || requestCode == REQUEST_BLUETOOTH || requestCode == REQUEST_NOTIFICATIONS) {
            refreshPermissions()
        }
    }

    companion object {
        private const val REQUEST_CAMERA = 501
        private const val REQUEST_BLUETOOTH = 502
        private const val REQUEST_NOTIFICATIONS = 503
        private const val NOTIFICATION_CHANNEL_ID = "storage_node_status"
    }
}
