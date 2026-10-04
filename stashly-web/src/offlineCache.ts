/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

import { FileMeta } from "./api";

const DB_NAME = "stashly-offline-v1";
const STORE_NAME = "downloads";
const DB_VERSION = 1;

export interface OfflineDownload {
  fileId: string;
  ciphertext: ArrayBuffer;
  wrappedDek: string;
  metadata: Pick<FileMeta, "deviceId" | "name" | "mimeType" | "sizeBytes" | "contentHash">;
  cachedAt: string;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("IndexedDB is unavailable"));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME, { keyPath: "fileId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open offline cache"));
  });
}

export async function saveOfflineDownload(file: FileMeta, ciphertext: ArrayBuffer, wrappedDek: string): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put({
      fileId: file.id,
      ciphertext,
      wrappedDek,
      metadata: {
        deviceId: file.deviceId,
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        contentHash: file.contentHash,
      },
      cachedAt: new Date().toISOString(),
    } satisfies OfflineDownload);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not save offline download"));
  }).finally(() => db.close());
}

export async function getOfflineDownload(fileId: string): Promise<OfflineDownload | null> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(fileId);
    request.onsuccess = () => {
      db.close();
      resolve((request.result as OfflineDownload | undefined) ?? null);
    };
    request.onerror = () => {
      db.close();
      reject(request.error ?? new Error("Could not read offline cache"));
    };
  });
}

export async function deleteOfflineDownload(fileId: string): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(fileId);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not remove offline download"));
  }).finally(() => db.close());
}

export async function clearOfflineDownloads(): Promise<void> {
  if (!("indexedDB" in window)) return;
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not clear offline cache"));
  }).finally(() => db.close());
}
