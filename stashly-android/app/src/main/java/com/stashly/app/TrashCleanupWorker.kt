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
