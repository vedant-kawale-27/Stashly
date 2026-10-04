/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

package com.stashly.app

import android.app.AlertDialog
import android.os.Bundle
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.stashly.app.databinding.ActivityRecycleBinBinding
import com.stashly.app.databinding.ItemRecycleBinBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.DateFormat
import java.util.Date

class RecycleBinActivity : AppCompatActivity() {
    private lateinit var binding: ActivityRecycleBinBinding
    private lateinit var storage: SecureStorage
    private lateinit var vault: FileVault

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityRecycleBinBinding.inflate(layoutInflater)
        setContentView(binding.root)
        storage = SecureStorage(this)
        vault = FileVault(this, KeyManager(storage), storage)
        binding.recycleToolbar.setNavigationOnClickListener { finish() }
        loadItems()
    }

    private fun loadItems() {
        lifecycleScope.launch {
            val items = withContext(Dispatchers.IO) {
                vault.purgeExpiredTrash()
                vault.listTrash()
            }
            render(items)
        }
    }

    private fun render(items: List<TrashEntry>) {
        binding.recycleList.removeAllViews()
        binding.recycleEmptyText.visibility = if (items.isEmpty()) android.view.View.VISIBLE else android.view.View.GONE
        binding.recycleList.visibility = if (items.isEmpty()) android.view.View.GONE else android.view.View.VISIBLE
        binding.recycleSummaryText.text = if (items.isEmpty()) {
            "Deleted items are automatically removed after 30 days."
        } else {
            "${items.size} item(s) in Stashly Recycle Bin. Items are permanently removed after 30 days."
        }

        items.forEach { item ->
            val row = ItemRecycleBinBinding.inflate(layoutInflater, binding.recycleList, false)
            row.trashItemName.text = if (item.isDirectory) "Folder: ${item.name}" else item.name
            row.trashItemPath.text = "Original location: ${item.path}"
            row.trashItemAge.text = "Deleted: ${DateFormat.getDateTimeInstance().format(Date(item.trashedAt))}"
            row.trashRestoreButton.setOnClickListener { confirmRestore(item) }
            row.trashDeleteButton.setOnClickListener { confirmPermanentDelete(item) }
            binding.recycleList.addView(row.root)
        }
    }

    private fun confirmRestore(item: TrashEntry) {
        AlertDialog.Builder(this)
            .setTitle("Restore item?")
            .setMessage("Restore ${item.name} to ${item.path}?")
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Restore") { _, _ -> performTrashAction(item, false) }
            .show()
    }

    private fun confirmPermanentDelete(item: TrashEntry) {
        AlertDialog.Builder(this)
            .setTitle("Delete permanently?")
            .setMessage("${item.name} will be permanently removed from this Android device. This cannot be undone.")
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Delete") { _, _ -> performTrashAction(item, true) }
            .show()
    }

    private fun performTrashAction(item: TrashEntry, permanent: Boolean) {
        lifecycleScope.launch {
            val success = withContext(Dispatchers.IO) {
                if (permanent) vault.permanentDelete(item.path) else vault.restoreFromTrash(item.path)
            }
            if (success) {
                syncNode()
                Toast.makeText(this@RecycleBinActivity, if (permanent) "Item permanently deleted" else "Item restored", Toast.LENGTH_SHORT).show()
                loadItems()
            } else {
                Toast.makeText(this@RecycleBinActivity, "The item is no longer available", Toast.LENGTH_LONG).show()
                loadItems()
            }
        }
    }

    private fun syncNode() {
        if (storage.isPaired && storage.nodeEnabled) {
            startForegroundService(android.content.Intent(this, StorageNodeService::class.java).setAction(StorageNodeService.ACTION_SYNC_NOW))
        }
    }
}
