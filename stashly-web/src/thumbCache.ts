/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

// Thumbnail cache using IndexedDB for fast, persistent thumbnail storage.
// Thumbnails are stored as decrypted Blob URLs keyed by fileId + contentHash.
// This avoids re-downloading and re-decrypting thumbnails on every page load.

const DB_NAME = "stashly_thumbs";
const DB_VERSION = 1;
const STORE_NAME = "thumbnails";
const MAX_CACHE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface ThumbRecord {
  key: string;          // `${fileId}:${contentHash}`
  blob: Blob;           // decrypted JPEG thumbnail
  sizeBytes: number;
  storedAt: number;     // Date.now()
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "key" });
        store.createIndex("storedAt", "storedAt", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
  });
  return dbPromise;
}

/** Get a cached thumbnail Blob URL, or null if not cached. */
export async function getCachedThumbnail(fileId: string, contentHash: string): Promise<string | null> {
  try {
    const db = await openDB();
    const key = `${fileId}:${contentHash}`;
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => {
        const record = req.result as ThumbRecord | undefined;
        if (!record) return resolve(null);
        // Check expiry
        if (Date.now() - record.storedAt > MAX_AGE_MS) {
          // Expired — delete async and return null
          deleteThumb(key).catch(() => {});
          return resolve(null);
        }
        resolve(URL.createObjectURL(record.blob));
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

/** Store a decrypted thumbnail in the cache. */
export async function cacheThumbnail(
  fileId: string,
  contentHash: string,
  decryptedBytes: ArrayBuffer,
): Promise<string> {
  const blob = new Blob([decryptedBytes], { type: "image/jpeg" });
  const objectUrl = URL.createObjectURL(blob);

  try {
    const db = await openDB();
    const record: ThumbRecord = {
      key: `${fileId}:${contentHash}`,
      blob,
      sizeBytes: decryptedBytes.byteLength,
      storedAt: Date.now(),
    };

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    // Run eviction in background
    evictIfNeeded().catch(() => {});
  } catch {
    // Cache write failed — the blob URL is still valid for this session
  }

  return objectUrl;
}

async function deleteThumb(key: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function evictIfNeeded(): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, "readonly");
  const store = tx.objectStore(STORE_NAME);
  const index = store.index("storedAt");

  const allRecords: ThumbRecord[] = await new Promise((resolve) => {
    const records: ThumbRecord[] = [];
    const cursor = index.openCursor();
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (c) {
        records.push(c.value);
        c.continue();
      } else {
        resolve(records);
      }
    };
    cursor.onerror = () => resolve([]);
  });

  // Remove expired entries
  const now = Date.now();
  const expired = allRecords.filter((r) => now - r.storedAt > MAX_AGE_MS);
  for (const r of expired) {
    await deleteThumb(r.key).catch(() => {});
  }

  // Check total size and evict oldest if over limit
  const remaining = allRecords.filter((r) => now - r.storedAt <= MAX_AGE_MS);
  let totalSize = remaining.reduce((sum, r) => sum + r.sizeBytes, 0);

  if (totalSize > MAX_CACHE_SIZE_BYTES) {
    // Evict oldest first
    const sorted = remaining.sort((a, b) => a.storedAt - b.storedAt);
    for (const r of sorted) {
      if (totalSize <= MAX_CACHE_SIZE_BYTES) break;
      await deleteThumb(r.key).catch(() => {});
      totalSize -= r.sizeBytes;
    }
  }
}

/** Clear the entire thumbnail cache. */
export async function clearThumbnailCache(): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Ignore
  }
}
