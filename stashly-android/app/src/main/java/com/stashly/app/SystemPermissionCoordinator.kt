/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

package com.stashly.app

import android.content.Context
import android.os.Build
import android.os.Environment

/** Centralizes platform permission policy used by the main screen. */
object SystemPermissionCoordinator {
    fun hasFullStorageAccess(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.R || Environment.isExternalStorageManager()

    fun bluetoothPermissions(): Array<String> = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        arrayOf(android.Manifest.permission.BLUETOOTH_ADVERTISE, android.Manifest.permission.BLUETOOTH_CONNECT)
    } else {
        emptyArray()
    }
}
