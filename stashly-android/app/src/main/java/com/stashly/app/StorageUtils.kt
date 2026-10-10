package com.stashly.app

import android.content.Context
import android.os.Build
import android.os.Environment
import android.os.storage.StorageManager
import androidx.core.content.ContextCompat
import java.io.File

object StorageUtils {

    /**
     * Checks if the device has physical SD card slot / removable storage volume support.
     */
    fun hasSdCardSupport(context: Context): Boolean {
        try {
            val sm = context.getSystemService(Context.STORAGE_SERVICE) as? StorageManager
            if (sm != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                for (vol in sm.storageVolumes) {
                    if (vol.isRemovable) return true
                }
            }
            val dirs = ContextCompat.getExternalFilesDirs(context, null)
            for (f in dirs) {
                if (f != null && Environment.isExternalStorageRemovable(f)) return true
            }
        } catch (_: Exception) {}
        return false
    }

    /**
     * Finds the currently mounted removable SD card directory, or null if none.
     */
    fun getMountedSdCardFile(context: Context): File? {
        try {
            val sm = context.getSystemService(Context.STORAGE_SERVICE) as? StorageManager
            if (sm != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                for (vol in sm.storageVolumes) {
                    if (vol.isRemovable) {
                        val state = vol.state
                        if (state == Environment.MEDIA_MOUNTED || state == Environment.MEDIA_MOUNTED_READ_ONLY) {
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                                vol.directory?.let { if (it.exists() && it.canRead()) return it }
                            }
                            try {
                                val getPathMethod = vol.javaClass.getMethod("getPath")
                                val pathStr = getPathMethod.invoke(vol) as? String
                                if (pathStr != null) {
                                    val f = File(pathStr)
                                    if (f.exists() && f.canRead()) return f
                                }
                            } catch (_: Exception) {}
                        }
                    }
                }
            }

            val dirs = ContextCompat.getExternalFilesDirs(context, null)
            for (f in dirs) {
                if (f != null && Environment.isExternalStorageRemovable(f)) {
                    val state = Environment.getExternalStorageState(f)
                    if (state == Environment.MEDIA_MOUNTED || state == Environment.MEDIA_MOUNTED_READ_ONLY) {
                        // Find the root of the removable volume (parent before /Android)
                        var cur: File? = f
                        while (cur != null && cur.parentFile != null && cur.parentFile?.name != "storage") {
                            if (cur.name == "Android") {
                                return cur.parentFile
                            }
                            cur = cur.parentFile
                        }
                        return f
                    }
                }
            }

            val storageRoot = File("/storage")
            if (storageRoot.exists() && storageRoot.isDirectory) {
                val subDirs = storageRoot.listFiles()
                if (subDirs != null) {
                    for (sub in subDirs) {
                        if (sub.isDirectory && sub.name != "emulated" && sub.name != "self" && sub.canRead()) {
                            try {
                                if (Environment.isExternalStorageRemovable(sub)) {
                                    val state = Environment.getExternalStorageState(sub)
                                    if (state == Environment.MEDIA_MOUNTED || state == Environment.MEDIA_MOUNTED_READ_ONLY) {
                                        return sub
                                    }
                                }
                            } catch (_: Exception) {}
                        }
                    }
                }
            }
        } catch (_: Exception) {}
        return null
    }
}
