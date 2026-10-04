/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

package com.stashly.app

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters

class TrashCleanupWorker(
    appContext: Context,
    workerParams: WorkerParameters,
) : CoroutineWorker(appContext, workerParams) {
    override suspend fun doWork(): Result {
        return runCatching {
            val storage = SecureStorage(applicationContext)
            FileVault(applicationContext, KeyManager(storage), storage).purgeExpiredTrash()
            Result.success()
        }.getOrElse { Result.retry() }
    }
}
