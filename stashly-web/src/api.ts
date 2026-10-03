/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

// Stashly API Client
import { bytesToBase64 } from "./crypto";

export interface SharedUser {
  userId: string;
  email: string;
  role: string;
  scopeMode?: "ALL" | "CUSTOM_FOLDER" | "CUSTOM_FILE" | "NONE";
  scopePath?: string | null;
  scopeName?: string | null;
  sharingEnabled?: boolean;
  isLive?: boolean;
  lastSeenAt?: string | null;
  connectedAt?: string;
  since: string;
}

export interface Device {
  id: string;
  name: string;
  platform: string;
  osVersion: string | null;
  appVersion: string | null;
  modelName?: string | null;
  modelNumber?: string | null;
  androidVersion?: string | null;
  batteryLevel?: number | null;
  storageTotalMb?: number | null;
  storageFreeMb?: number | null;
  status: "online" | "offline";
  storageQuotaMb: number;
  createdAt: string;
  lastSeenAt?: string | null;
  fileCount?: number;
  role?: string;
  sharingEnabled?: boolean;
  sharedWith?: SharedUser[];
}

export interface FileMeta {
  id: string;
  deviceId: string;
  path: string;
  name: string;
  sizeBytes: number;
  contentHash: string;
  mimeType: string | null;
  encryptedDek: string;
  deviceOnline: boolean;
  isCached?: boolean;
  cachedAt?: string | null;
  lastAccessAt?: string | null;
  deletedAt?: string | null;
  hasThumbnail?: boolean;
  encryptionFormat?: "single" | "chunked";
}

export interface DownloadedFile {
  ciphertext: ArrayBuffer;
  wrappedDek: string;
  fromCache?: boolean;
}

export class ApiError extends Error {
  constructor(message: string, public status?: number, public code?: string) {
    super(message);
    this.name = "ApiError";
  }
}

type CacheEntry<T = unknown> = { expiresAt: number; value: T };
const responseCache = new Map<string, CacheEntry>();
const pendingRequests = new Map<string, Promise<unknown>>();
const CACHE_STORAGE_KEY = "stashly_api_cache_v2";
const MAX_PERSISTED_ENTRIES = 40;

type PersistedCache = Record<string, { expiresAt: number; value: unknown }>;

function readPersistentCache(): PersistedCache {
  try {
    const raw = localStorage.getItem(CACHE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as PersistedCache;
    const now = Date.now();
    const valid: PersistedCache = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v && typeof v.expiresAt === "number" && v.expiresAt > now) {
        valid[k] = v;
      }
    }
    return valid;
  } catch {
    return {};
  }
}

function writePersistentCache(cache: PersistedCache) {
  try {
    const now = Date.now();
    const entries = Object.entries(cache)
      .filter(([, v]) => v && typeof v.expiresAt === "number" && v.expiresAt > now)
      .slice(-MAX_PERSISTED_ENTRIES);
    localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // A full or disabled localStorage must never block broker access.
  }
}

function loadCachedEntry<T>(key: string): T | undefined {
  const now = Date.now();
  const inMemory = responseCache.get(key);
  if (inMemory) {
    if (inMemory.expiresAt > now) return inMemory.value as T;
    responseCache.delete(key);
  }
  const persisted = readPersistentCache();
  const item = persisted[key];
  if (item && item.expiresAt > now) {
    responseCache.set(key, item);
    return item.value as T;
  }
  return undefined;
}

export function clearBrowserApiCache() {
  responseCache.clear();
  pendingRequests.clear();
  try {
    localStorage.removeItem(CACHE_STORAGE_KEY);
    localStorage.removeItem("stashly_api_cache_v1");
  } catch {}
}

function invalidateCache(prefix: string) {
  for (const key of responseCache.keys()) {
    if (key.startsWith(prefix)) responseCache.delete(key);
  }
  const persisted = readPersistentCache();
  let changed = false;
  for (const key of Object.keys(persisted)) {
    if (key.startsWith(prefix)) {
      delete persisted[key];
      changed = true;
    }
  }
  if (changed) writePersistentCache(persisted);
}

function cachedRequest<T>(
  key: string,
  request: () => Promise<T>,
  force = false,
  ttlMs = 15_000,
  persist = true
): Promise<T> {
  if (!force) {
    const cached = loadCachedEntry<T>(key);
    if (cached !== undefined) return Promise.resolve(cached);

    const pending = pendingRequests.get(key);
    if (pending) return pending as Promise<T>;
  }

  const pending = request()
    .then((value) => {
      const entry = { value, expiresAt: Date.now() + ttlMs };
      responseCache.set(key, entry);
      if (persist) {
        const persisted = readPersistentCache();
        persisted[key] = entry;
        writePersistentCache(persisted);
      }
      return value;
    })
    .finally(() => {
      pendingRequests.delete(key);
    });

  pendingRequests.set(key, pending);
  return pending;
}

async function parseJsonOrThrow<T = Record<string, unknown>>(res: Response): Promise<T> {
  const text = await res.text();
  let json: { error?: string } & T = {} as { error?: string } & T;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      if (!res.ok) {
        throw new ApiError(`Request failed (HTTP ${res.status})`, res.status);
      }
    }
  }
  if (!res.ok) {
    throw new ApiError(json.error ?? `Request failed (HTTP ${res.status})`, res.status);
  }
  return json;
}

export interface BrokerInfo {
  ok: boolean;
  service: string;
  nodeEnv: string;
  isProduction: boolean;
  publicUrl: string | null;
  localLanUrl: string;
  localIp: string;
  port: number;
  suggestedBrokerUrl: string;
}

export class BrokerClient {
  public readonly baseUrl: string;

  constructor(baseUrl: string, private token?: string) {
    // Clean up baseUrl
    this.baseUrl = (baseUrl || "").trim().replace(/\/+$/, "");
  }

  withToken(token: string): BrokerClient {
    return new BrokerClient(this.baseUrl, token);
  }

  private authHeaders(): HeadersInit {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  async health(): Promise<{ ok: boolean; service?: string }> {
    const res = await fetch(`${this.baseUrl}/health`);
    return parseJsonOrThrow(res);
  }

  async fetchInfo(): Promise<BrokerInfo> {
    return cachedRequest(`${this.baseUrl}:info`, async () => {
      const res = await fetch(`${this.baseUrl}/info`);
      return parseJsonOrThrow<BrokerInfo>(res);
    }, false, 60_000);
  }

  async register(email: string, password: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const json = await parseJsonOrThrow<{ token: string }>(res);
    return json.token;
  }

  async login(email: string, password: string): Promise<{ token?: string; mfaRequired?: boolean; challenge?: string }> {
    const res = await fetch(`${this.baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    return parseJsonOrThrow(res);
  }

  async verifyMfa(challenge: string, code: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/auth/login/mfa`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challenge, code }),
    });
    return (await parseJsonOrThrow<{ token: string }>(response)).token;
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/auth/password`, {
      method: "POST",
      headers: { ...this.authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    if (!res.ok) await parseJsonOrThrow(res);
  }

  async mfaStatus(): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/auth/mfa/status`, { headers: this.authHeaders() });
    return (await parseJsonOrThrow<{ enabled: boolean }>(res)).enabled;
  }
  async beginMfaSetup(): Promise<{ secret: string; otpauthUri: string }> {
    const res = await fetch(`${this.baseUrl}/auth/mfa/setup`, { method: "POST", headers: this.authHeaders() });
    return parseJsonOrThrow(res);
  }
  async confirmMfa(code: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/auth/mfa/verify`, { method: "POST", headers: { ...this.authHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
    if (!res.ok) await parseJsonOrThrow(res);
  }
  async disableMfa(code: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/auth/mfa`, { method: "DELETE", headers: { ...this.authHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
    if (!res.ok) await parseJsonOrThrow(res);
  }
  async createShare(fileId: string, deviceId: string, expiresInSeconds = 86400): Promise<{ id: string; token: string; url: string; expiresAt: string }> {
    const res = await fetch(`${this.baseUrl}/shares`, { method: "POST", headers: { ...this.authHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ fileId, deviceId, expiresInSeconds }) });
    const result = await parseJsonOrThrow<{ id: string; token: string; url: string; expiresAt: string }>(res);
    return { ...result, url: result.url.startsWith("http") ? result.url : `${this.baseUrl}${result.url}` };
  }
  async listShares(): Promise<Array<{ id: string; fileId: string | null; expiresAt: string; revokedAt: string | null; accessCount: number }>> {
    const res = await fetch(`${this.baseUrl}/shares`, { headers: this.authHeaders() });
    return parseJsonOrThrow(res);
  }
  async revokeShare(id: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/shares/${encodeURIComponent(id)}`, { method: "DELETE", headers: this.authHeaders() });
    if (!res.ok && res.status !== 204) await parseJsonOrThrow(res);
  }

  async createPairingToken(): Promise<{ token: string; expiresAt: string }> {
    const res = await fetch(`${this.baseUrl}/devices/pairing-tokens`, {
      method: "POST",
      headers: this.authHeaders(),
    });
    return parseJsonOrThrow(res);
  }

  async listDevices(force = false): Promise<Device[]> {
    const key = `${this.baseUrl}:devices:${this.token ?? "anonymous"}`;
    return cachedRequest(key, async () => {
      const res = await fetch(`${this.baseUrl}/devices`, { headers: this.authHeaders() });
      const devices = await parseJsonOrThrow<Device[]>(res);
      if (force && devices.some((device) => device.status !== "online")) {
        invalidateCache(`${this.baseUrl}:files:${this.token ?? "anonymous"}`);
      }
      return devices;
    }, force, 6_000);
  }

  async renameDevice(deviceId: string, name: string): Promise<{ id: string; name: string }> {
    const res = await fetch(`${this.baseUrl}/devices/${deviceId}`, {
      method: "PATCH",
      headers: { ...this.authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const result = await parseJsonOrThrow<{ id: string; name: string }>(res);
    invalidateCache(`${this.baseUrl}:devices:${this.token ?? "anonymous"}`);
    return result;
  }

  async unpairDevice(deviceId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/devices/${deviceId}`, {
      method: "DELETE",
      headers: this.authHeaders(),
    });
    if (!res.ok && res.status !== 204) await parseJsonOrThrow(res);
    invalidateCache(`${this.baseUrl}:devices:${this.token ?? "anonymous"}`);
    invalidateCache(`${this.baseUrl}:files:${this.token ?? "anonymous"}`);
  }

  async setPresence(online: boolean): Promise<void> {
    const res = await fetch(`${this.baseUrl}/devices/presence`, {
      method: online ? "POST" : "DELETE",
      headers: this.authHeaders(),
    });
    if (!res.ok && res.status !== 204) await parseJsonOrThrow(res);
  }

  async listFiles(deviceId?: string, force = false, trash = false): Promise<FileMeta[]> {
    const url = new URL(`${this.baseUrl}/files`);
    if (deviceId) url.searchParams.set("deviceId", deviceId);
    if (trash) url.searchParams.set("trash", "true");
    const key = `${this.baseUrl}:files:${this.token ?? "anonymous"}:${deviceId ?? "all"}:${trash ? "trash" : "active"}`;
    return cachedRequest(key, async () => {
      const res = await fetch(url.toString(), { headers: this.authHeaders() });
      return parseJsonOrThrow<FileMeta[]>(res);
    }, force, 8_000);
  }

  async listTrash(deviceId?: string, force = false): Promise<FileMeta[]> {
    return this.listFiles(deviceId, force, true);
  }

  async syncDevice(deviceId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/devices/${encodeURIComponent(deviceId)}/sync`, {
      method: "POST",
      headers: this.authHeaders(),
    });
    if (!res.ok) await parseJsonOrThrow(res);
    invalidateCache(`${this.baseUrl}:files:${this.token ?? "anonymous"}`);
    invalidateCache(`${this.baseUrl}:devices:${this.token ?? "anonymous"}`);
  }

  async downloadFile(fileId: string, encryptionFormat?: string): Promise<DownloadedFile> {
    // Use chunked streaming for files tagged as "chunked" format
    if (encryptionFormat === "chunked") {
      return this.downloadFileChunked(fileId);
    }

    // Legacy full-file download for "single" format (or untagged files)
    const res = await fetch(`${this.baseUrl}/files/${fileId}/download`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new ApiError(json.error ?? `Download failed (HTTP ${res.status})`, res.status, json.code);
    }
    const wrappedDek = res.headers.get("X-Encrypted-Dek");
    if (!wrappedDek) {
      throw new ApiError(
        "Broker didn't return encryption metadata (X-Encrypted-Dek)"
      );
    }
    const fromCache = res.headers.get("X-From-Local-Cache") === "true";
    const ciphertext = await res.arrayBuffer();
    return { ciphertext, wrappedDek, fromCache };
  }

  /**
   * Download a file using chunked streaming. Each chunk is independently
   * AES-GCM encrypted and can be decrypted separately. The broker never
   * holds the full file in memory — it relays chunks from the Android device.
   *
   * Response format: [4-byte BE length][encrypted chunk]...[0x00000000]
   */
  async downloadFileChunked(
    fileId: string,
    range?: { start: number; end?: number },
  ): Promise<DownloadedFile> {
    const headers = new Headers(this.authHeaders());
    if (range) headers.set("Range", `bytes=${range.start}-${range.end ?? ""}`);
    const res = await fetch(`${this.baseUrl}/files/${fileId}/download?stream=chunked`, {
      headers,
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new ApiError(json.error ?? `Chunked download failed (HTTP ${res.status})`, res.status, json.code);
    }

    const wrappedDek = res.headers.get("X-Encrypted-Dek");
    if (!wrappedDek) {
      throw new ApiError("Broker didn't return X-Encrypted-Dek for chunked download");
    }

    const reader = res.body?.getReader();
    if (!reader) {
      throw new ApiError("Browser doesn't support ReadableStream");
    }

    // Read the full response and parse length-prefixed chunks
    const encryptedChunks: Uint8Array[] = [];
    let buffer = new Uint8Array(0);
    let ended = false;

    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        // Append to buffer
        const newBuf = new Uint8Array(buffer.length + value.length);
        newBuf.set(buffer, 0);
        newBuf.set(value, buffer.length);
        buffer = newBuf;
      }

      // Parse complete chunks from buffer
      while (buffer.length >= 4) {
        const chunkLen = new DataView(buffer.buffer, buffer.byteOffset).getUint32(0, false);
        if (chunkLen === 0) {
          // End marker
          if (buffer.length !== 4) throw new ApiError("Unexpected data after chunked end marker");
          ended = true;
          buffer = new Uint8Array(0);
          break;
        }
        if (buffer.length < 4 + chunkLen) break; // need more data
        encryptedChunks.push(buffer.slice(4, 4 + chunkLen));
        buffer = buffer.subarray(4 + chunkLen);
      }

      if (done) break;
    }

    if (!ended || buffer.length !== 0) {
      throw new ApiError("Chunked download ended before a valid end marker");
    }

    // Combine all encrypted chunks into a single ArrayBuffer for decryption.
    // Each chunk has its own AES-GCM IV, so we need to decrypt them individually
    // and then concatenate the plaintext.
    // Return the chunks as a "ciphertext" that the caller will handle.
    // We store them with a special format: [4-byte count][4-byte len1][chunk1][4-byte len2][chunk2]...
    const totalEncryptedBytes = encryptedChunks.reduce((sum, c) => sum + c.length, 0);
    const combined = new Uint8Array(4 + encryptedChunks.length * 4 + totalEncryptedBytes);
    const view = new DataView(combined.buffer);
    view.setUint32(0, encryptedChunks.length, false);
    let offset = 4;
    for (const chunk of encryptedChunks) {
      view.setUint32(offset, chunk.length, false);
      offset += 4;
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    return {
      ciphertext: combined.buffer as ArrayBuffer,
      wrappedDek,
      fromCache: false,
    };
  }

  /**
   * Stream a chunked download with per-chunk callback. Unlike downloadFileChunked()
   * which buffers everything into one ArrayBuffer, this method delivers each
   * encrypted chunk as it arrives. The caller can decrypt and write each chunk
   * to a FileSystemWritableFileStream (File System Access API) or any other
   * sink without holding the entire file in memory.
   *
   * Returns the wrappedDek so the caller can unwrap it once and decrypt all chunks.
   */
  async streamDownloadChunked(
    fileId: string,
    onEncryptedChunk: (chunk: Uint8Array, index: number, wrappedDek: string) => Promise<void>,
    range?: { start: number; end?: number },
  ): Promise<{ wrappedDek: string; chunkCount: number }> {
    const headers = new Headers(this.authHeaders());
    if (range) headers.set("Range", `bytes=${range.start}-${range.end ?? ""}`);
    const res = await fetch(`${this.baseUrl}/files/${fileId}/download?stream=chunked`, {
      headers,
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new ApiError(json.error ?? `Streaming download failed (HTTP ${res.status})`, res.status, json.code);
    }

    const wrappedDek = res.headers.get("X-Encrypted-Dek");
    if (!wrappedDek) {
      throw new ApiError("Broker didn't return X-Encrypted-Dek for streaming download");
    }

    const reader = res.body?.getReader();
    if (!reader) {
      throw new ApiError("Browser doesn't support ReadableStream");
    }

    let buffer = new Uint8Array(0);
    let chunkIndex = 0;
    let finished = false;

    while (!finished) {
      const { done, value } = await reader.read();
      if (value) {
        const newBuf = new Uint8Array(buffer.length + value.length);
        newBuf.set(buffer, 0);
        newBuf.set(value, buffer.length);
        buffer = newBuf;
      }

      // Parse and deliver complete chunks as they arrive
      while (buffer.length >= 4) {
        const chunkLen = new DataView(buffer.buffer, buffer.byteOffset).getUint32(0, false);
        if (chunkLen === 0) {
          if (buffer.length !== 4) throw new ApiError("Unexpected data after chunked end marker");
          finished = true;
          break;
        }
        if (buffer.length < 4 + chunkLen) break; // need more data
        const chunk = buffer.slice(4, 4 + chunkLen);
        buffer = buffer.subarray(4 + chunkLen);
        await onEncryptedChunk(chunk, chunkIndex++, wrappedDek);
      }

      if (done) break;
    }

    if (!finished || buffer.length !== 0) {
      throw new ApiError("Chunked stream ended before a valid end marker");
    }

    return { wrappedDek, chunkCount: chunkIndex };
  }

  async downloadThumbnail(fileId: string): Promise<DownloadedFile | null> {
    const res = await fetch(`${this.baseUrl}/files/${fileId}/thumbnail`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) return null;
    const wrappedDek = res.headers.get("X-Encrypted-Dek");
    if (!wrappedDek) return null;
    const ciphertext = await res.arrayBuffer();
    return { ciphertext, wrappedDek };
  }

  async uploadFile(
    deviceId: string,
    path: string,
    name: string,
    mimeType: string | null,
    ciphertext: ArrayBuffer,
    encryptedDek: string,
  ): Promise<void> {
    const bytes = new Uint8Array(ciphertext);
    const start = await fetch(`${this.baseUrl}/files/uploads`, {
      method: "POST",
      headers: { ...this.authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId, path, name, mimeType, encryptedDek, totalBytes: bytes.byteLength }),
    });
    const upload = await parseJsonOrThrow<{ uploadId: string; receivedBytes: number }>(start);
    const chunkSize = 4 * 1024 * 1024;
    for (let offset = upload.receivedBytes; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.slice(offset, Math.min(offset + chunkSize, bytes.length));
      const res = await fetch(`${this.baseUrl}/files/uploads/${encodeURIComponent(upload.uploadId)}/chunks`, {
        method: "POST",
        headers: { ...this.authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ offset, dataBase64: bytesToBase64(chunk) }),
      });
      if (!res.ok) await parseJsonOrThrow(res);
    }
    invalidateCache(`${this.baseUrl}:files:${this.token ?? "anonymous"}`);
  }

  async createFolder(deviceId: string, path: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/files/folders`, {
      method: "POST", headers: { ...this.authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId, path }),
    });
    if (!res.ok) await parseJsonOrThrow(res);
    invalidateCache(`${this.baseUrl}:files:${this.token ?? "anonymous"}`);
  }

  async moveFile(fileId: string, path: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/files/${encodeURIComponent(fileId)}`, {
      method: "PATCH", headers: { ...this.authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    if (!res.ok) await parseJsonOrThrow(res);
    invalidateCache(`${this.baseUrl}:files:${this.token ?? "anonymous"}`);
  }

  async restoreFile(fileId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/files/${encodeURIComponent(fileId)}/restore`, {
      method: "POST", headers: this.authHeaders(),
    });
    if (!res.ok) await parseJsonOrThrow(res);
    invalidateCache(`${this.baseUrl}:files:${this.token ?? "anonymous"}`);
  }

  async listVersions(fileId: string): Promise<FileMeta[]> {
    const res = await fetch(`${this.baseUrl}/files/${encodeURIComponent(fileId)}/versions`, { headers: this.authHeaders() });
    return parseJsonOrThrow<FileMeta[]>(res);
  }

  async deleteFile(fileId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/files/${encodeURIComponent(fileId)}`, {
      method: "DELETE",
      headers: this.authHeaders(),
    });
    if (!res.ok && res.status !== 204) await parseJsonOrThrow(res);
    invalidateCache(`${this.baseUrl}:files:${this.token ?? "anonymous"}`);
  }

  async deletePermanently(fileId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/files/${encodeURIComponent(fileId)}?permanent=true`, {
      method: "DELETE",
      headers: this.authHeaders(),
    });
    if (!res.ok && res.status !== 204) await parseJsonOrThrow(res);
    invalidateCache(`${this.baseUrl}:files:${this.token ?? "anonymous"}`);
  }

  async emptyTrash(deviceId?: string): Promise<void> {
    const url = new URL(`${this.baseUrl}/files/trash/empty`);
    if (deviceId) url.searchParams.set("deviceId", deviceId);
    const res = await fetch(url.toString(), {
      method: "DELETE",
      headers: this.authHeaders(),
    });
    if (!res.ok && res.status !== 204) await parseJsonOrThrow(res);
    invalidateCache(`${this.baseUrl}:files:${this.token ?? "anonymous"}`);
  }
}
