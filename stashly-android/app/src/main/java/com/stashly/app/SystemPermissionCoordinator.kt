/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

package com.stashly.app

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Environment
import androidx.core.content.ContextCompat

/** Centralizes platform permission policy used by the main screen. */
object SystemPermissionCoordinator {
    fun hasFullStorageAccess(context: Context): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Environment.isExternalStorageManager()
        } else {
            ContextCompat.checkSelfPermission(
                context,
                android.Manifest.permission.READ_EXTERNAL_STORAGE
            ) == PackageManager.PERMISSION_GRANTED
        }

    fun bluetoothPermissions(): Array<String> = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        arrayOf(android.Manifest.permission.BLUETOOTH_ADVERTISE, android.Manifest.permission.BLUETOOTH_CONNECT)
    } else {
        arrayOf(android.Manifest.permission.ACCESS_FINE_LOCATION)
    }

    /**
     * Gate an action on full storage access.
     * @param context the context to verify permissions.
     * @param action the work to do if permission is granted.
     * @param onNeedsPermission called if permission is missing (Activity shows dialog).
     */
    inline fun withStorageAccess(context: Context, action: () -> Unit, onNeedsPermission: () -> Unit) {
        if (hasFullStorageAccess(context)) action() else onNeedsPermission()
    }
}
