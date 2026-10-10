/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

import { WebSocket } from "ws";
import { v4 as uuid } from "uuid";
import fs from "fs";
import path from "path";
import { config } from "../config";
import { prisma } from "../db";
import { clientHub } from "./clientHub";

// --- Wire protocol between broker <-> phone app (over one persistent WS) ---
//
// Phone -> Broker:
//   { type: "hello", deviceId, modelName, modelNumber, androidVersion,
//     osVersion, appVersion, batteryLevel, storageTotalMb, storageFreeMb }
//   { type: "file_sync", files: [{ path, name, sizeBytes, contentHash, mimeType, encryptedDek }] }
//   { type: "fetch_result", requestId, ok: true, dataBase64 }
//   { type: "fetch_result", requestId, ok: false, error }
//   { type: "upload_result", requestId, ok: true }
//   { type: "sync_result", requestId, ok: true }
//
// Broker -> Phone:
//   { type: "fetch_request", requestId, path }
//   { type: "upload_request", requestId, path, dataBase64 }
//   { type: "sync_request", requestId }
//
// NOTE: files are base64-encoded and sent as single JSON messages for
// simplicity in this skeleton. For real file sizes, switch to binary WS
// frames with a small framing header (requestId + length prefix) instead
// of base64-in-JSON, which has ~33% overhead and no streaming.

interface PendingFetch {
  resolve: (data: Buffer) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingUpload {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingDelete {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingTrash {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingSync {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}
interface PendingFolder {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingChunk {
  resolve: (data: Buffer) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingThumbnail {
  resolve: (data: Buffer) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface FileSyncBatch {
  files: any[];
  receivedChunks: Set<number>;
  totalChunks: number;
  syncRequestId?: string;
}

export interface DeviceTelemetry {
  modelName: string | null;
  modelNumber: string | null;
  androidVersion: string | null;
  osVersion: string | null;
  appVersion: string | null;
  batteryLevel: number | null;
  storageTotalMb: number | null;
  storageFreeMb: number | null;
  sdcardMounted: boolean | null;
  sdcardTotalMb: number | null;
  sdcardFreeMb: number | null;
}

class DeviceHub {
  private sockets = new Map<string, WebSocket>(); // deviceId -> socket
  private pending = new Map<string, PendingFetch>(); // requestId -> pending fetch
  private pendingUploads = new Map<string, PendingUpload>();
  private pendingDeletes = new Map<string, PendingDelete>();
  private pendingTrash = new Map<string, PendingTrash>();
  private pendingSyncs = new Map<string, PendingSync>();
  private pendingFolders = new Map<string, PendingFolder>();
  private pendingChunks = new Map<string, PendingChunk>();
  private pendingThumbnails = new Map<string, PendingThumbnail>();
  private clientPresence = new Map<string, number>(); // deviceId:userId -> last web heartbeat
  private clientOnlineState = new Map<string, boolean>(); // deviceId:userId -> explicit online status
  private telemetry = new Map<string, DeviceTelemetry>(); // live only; intentionally never persisted
  private syncBatches = new Map<string, FileSyncBatch>();

  getDeviceTelemetry(deviceId: string): DeviceTelemetry {
    return this.telemetry.get(deviceId) ?? {
      modelName: null,
      modelNumber: null,
      androidVersion: null,
      osVersion: null,
      appVersion: null,
      batteryLevel: null,
      storageTotalMb: null,
      storageFreeMb: null,
      sdcardMounted: null,
      sdcardTotalMb: null,
      sdcardFreeMb: null,
    };
  }

  updateDeviceTelemetry(deviceId: string, update: Partial<DeviceTelemetry>) {
    this.telemetry.set(deviceId, { ...this.getDeviceTelemetry(deviceId), ...update });
  }

  isOnline(deviceId: string): boolean {
    return this.sockets.has(deviceId);
  }

  isClientOnline(deviceId: string, userId: string): boolean {
    const key = `${deviceId}:${userId}`;
    const explicitState = this.clientOnlineState.get(key);
    if (explicitState === false) return false;
    const lastSeen = this.clientPresence.get(key) ?? 0;
    return explicitState === true && (Date.now() - lastSeen < 45_000);
  }

  clientLastSeenAt(deviceId: string, userId: string): string | null {
    const lastSeen = this.clientPresence.get(`${deviceId}:${userId}`);
    return lastSeen ? new Date(lastSeen).toISOString() : null;
  }

  setClientPresence(deviceId: string, userId: string, online: boolean) {
    const key = `${deviceId}:${userId}`;
    this.clientPresence.set(key, Date.now());
    this.clientOnlineState.set(key, online);
    this.notifyClientPresence(deviceId, userId, online);
  }

  notifyDeviceRemoved(deviceId: string, reason = "Node was removed from the Stashly Web Dashboard") {
    const socket = this.sockets.get(deviceId);
    if (socket && socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ type: "node_unlinked", reason }));
      } catch { }
      setTimeout(() => {
        try {
          socket.close(4004, reason);
        } catch { }
        this.sockets.delete(deviceId);
      }, 200);
    }
  }

  notifyClientRemoved(deviceId: string, userId: string) {
    const socket = this.sockets.get(deviceId);
    if (socket?.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ type: "client_unlinked", userId }));
      } catch { }
    }
  }

  notifyClientPresence(deviceId: string, userId: string, online: boolean) {
    const socket = this.sockets.get(deviceId);
    if (socket?.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ type: "client_presence", userId, online }));
      } catch { }
    }
  }

  async registerConnection(deviceId: string, socket: WebSocket) {
    // If the same device reconnects, drop the old socket.
    const existing = this.sockets.get(deviceId);
    if (existing && existing !== socket) existing.terminate();

    try {
      await prisma.device.update({
        where: { id: deviceId },
        data: { status: "online", lastSeenAt: new Date() },
      });
    } catch (err: any) {
      if (err?.code === "P2025") {
        // The token this phone is holding points at a device row that no
        // longer exists (e.g. the DB was reset after it last paired).
        // Refuse the connection instead of crashing the broker for
        // everyone — the phone needs to re-pair to get a valid token.
        console.warn(`Rejecting connection for unknown device ${deviceId} (P2025) — needs re-pairing`);
        socket.close(4004, "Unknown device — re-pair required");
        return;
      }
      throw err;
    }

    this.sockets.set(deviceId, socket);
    socket.on("message", (raw, isBinary) => {
      if (isBinary) {
        this.handleBinaryMessage(deviceId, raw as Buffer);
      } else {
        this.handleMessage(deviceId, raw.toString());
      }
    });
    socket.on("close", () => this.handleDisconnect(deviceId, socket));
  }

  private async handleDisconnect(deviceId: string, socket: WebSocket) {
    if (this.sockets.get(deviceId) !== socket) return; // already replaced
    this.sockets.delete(deviceId);
    try {
      await prisma.device.update({
        where: { id: deviceId },
        data: { status: "offline", lastSeenAt: new Date() },
      });
    } catch (err: any) {
      if (err?.code !== "P2025") throw err; // device already gone — nothing to update, safe to ignore
    }
  }

  private async handleMessage(deviceId: string, raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // ignore malformed frames
    }

    switch (msg.type) {
      case "file_sync":
        await this.handleFileSync(deviceId, msg.files ?? []);
        if (typeof msg.syncRequestId === "string") {
          this.resolvePendingSync(msg.syncRequestId);
        }
        break;
      case "file_sync_chunk":
        await this.handleFileSyncChunk(deviceId, msg);
        break;
      case "file_delta":
        await this.handleFileDelta(deviceId, msg);
        break;
      case "hello":
        await this.handleHello(deviceId, msg);
        break;
      case "node_stop":
        await this.handleNodeStop(deviceId);
        break;
      case "sharing_pause":
        {
          const changed = await prisma.device.updateMany({
            where: { id: deviceId, sharingPaused: false },
            data: { sharingPaused: true },
          });
          if (changed.count === 0) break;
          await clientHub.pushToDeviceClients(deviceId, {
            type: "device_sharing_changed",
            deviceId,
            sharingPaused: true,
          });
        }
        break;
      case "fetch_result":
        this.handleFetchResult(msg);
        break;
      case "upload_result":
        this.handleUploadResult(msg);
        break;
      case "delete_result":
        this.handleDeleteResult(msg);
        break;
      case "trash_result":
        this.handleTrashResult(msg);
        break;
      case "sync_result":
        this.handleSyncResult(msg);
        break;
      case "folder_result":
        this.handleFolderResult(msg);
        break;
      default:
        break;
    }
  }

  private async handleHello(deviceId: string, msg: any) {
    const changed = await prisma.device.updateMany({
      where: { id: deviceId, sharingPaused: true },
      data: { sharingPaused: false },
    });
    const parseNum = (v: any) => {
      if (v == null) return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? Math.round(n) : undefined;
    };
    const storageTotal = parseNum(msg.storageTotalMb);
    const storageFree = parseNum(msg.storageFreeMb);
    const sdTotal = parseNum(msg.sdcardTotalMb);
    const sdFree = parseNum(msg.sdcardFreeMb);
    const battery = parseNum(msg.batteryLevel);

    this.updateDeviceTelemetry(deviceId, {
      ...(typeof msg.modelName === "string" ? { modelName: msg.modelName } : {}),
      ...(typeof msg.modelNumber === "string" ? { modelNumber: msg.modelNumber } : {}),
      ...(typeof msg.androidVersion === "string" ? { androidVersion: msg.androidVersion } : {}),
      ...(typeof msg.osVersion === "string" ? { osVersion: msg.osVersion } : {}),
      ...(typeof msg.appVersion === "string" ? { appVersion: msg.appVersion } : {}),
      ...(battery !== undefined ? { batteryLevel: battery } : {}),
      ...(storageTotal !== undefined ? { storageTotalMb: storageTotal } : {}),
      ...(storageFree !== undefined ? { storageFreeMb: storageFree } : {}),
      ...(msg.sdcardMounted !== undefined ? { sdcardMounted: Boolean(msg.sdcardMounted) } : {}),
      ...(sdTotal !== undefined ? { sdcardTotalMb: sdTotal } : {}),
      ...(sdFree !== undefined ? { sdcardFreeMb: sdFree } : {}),
    });

    await clientHub.pushToDeviceClients(deviceId, {
      type: "device_telemetry_changed",
      deviceId,
      status: "online",
      ...this.getDeviceTelemetry(deviceId),
    });
  }

  private async handleNodeStop(deviceId: string) {
    await this.clearDeviceFiles(deviceId);
  }

  private async clearDeviceFiles(deviceId: string) {
    const files = await prisma.fileEntry.findMany({
      where: { deviceId, deletedAt: null },
      select: { id: true, cacheKey: true },
    });

    await Promise.all(files.map((file) => {
      const cacheName = file.cacheKey ?? `${file.id}.bin`;
      return Promise.all([
        fs.promises.unlink(path.join(config.storageDir, cacheName)).catch(() => undefined),
        fs.promises.rm(path.join(config.storageDir, "chunks", file.id), { recursive: true, force: true }).catch(() => undefined),
      ]);
    }));
    await prisma.fileEntry.deleteMany({ where: { deviceId, deletedAt: null } });
  }

  private static readonly CHUNKED_THRESHOLD = 1024 * 1024; // 1 MB — files above this use chunked streaming

  private resolvePendingSync(requestId: string) {
    const pending = this.pendingSyncs.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingSyncs.delete(requestId);
    pending.resolve();
  }

  private async handleFileSyncChunk(deviceId: string, msg: any) {
    if (
      typeof msg.syncId !== "string" ||
      !Number.isInteger(msg.chunkIndex) ||
      !Number.isInteger(msg.totalChunks) ||
      msg.chunkIndex < 0 ||
      msg.totalChunks <= 0 ||
      !Array.isArray(msg.files)
    ) {
      return;
    }

    const batchKey = `${deviceId}:${msg.syncId}`;
    let batch = this.syncBatches.get(batchKey);
    if (!batch) {
      batch = {
        files: [],
        receivedChunks: new Set<number>(),
        totalChunks: msg.totalChunks,
        syncRequestId: typeof msg.syncRequestId === "string" ? msg.syncRequestId : undefined,
      };
      this.syncBatches.set(batchKey, batch);
    }

    if (batch.receivedChunks.has(msg.chunkIndex)) return;
    batch.receivedChunks.add(msg.chunkIndex);
    batch.files.push(...msg.files);
    if (typeof msg.syncRequestId === "string") batch.syncRequestId = msg.syncRequestId;

    if (batch.receivedChunks.size < batch.totalChunks) return;
    this.syncBatches.delete(batchKey);
    await this.handleFileSync(deviceId, batch.files);
    if (batch.syncRequestId) this.resolvePendingSync(batch.syncRequestId);
  }

  private async handleFileSync(deviceId: string, files: any[]) {
    const validFiles = files.filter((file) =>
      file && typeof file.path === "string" && typeof file.name === "string" &&
      typeof file.sizeBytes === "number" && typeof file.contentHash === "string" &&
      typeof file.encryptedDek === "string"
    );
    const incomingPaths = new Set(validFiles.map((file) => file.path));

    // Fetch all existing files for this device in a single query
    const existingFiles = await prisma.fileEntry.findMany({
      where: { deviceId },
      select: {
        id: true,
        path: true,
        name: true,
        sizeBytes: true,
        contentHash: true,
        mimeType: true,
        encryptedDek: true,
        cacheKey: true,
        deletedAt: true,
      },
    });

    const existingMap = new Map(existingFiles.map((f) => [f.path, f]));
    const removedFiles = existingFiles.filter((f) => !incomingPaths.has(f.path));

    // Clean up cache files for removed entries
    if (removedFiles.length > 0) {
      await Promise.all(removedFiles.map(async (file) => {
        const cacheName = file.cacheKey ?? `${file.id}.bin`;
        await fs.promises.unlink(path.join(config.storageDir, cacheName)).catch(() => undefined);
        await fs.promises.rm(path.join(config.storageDir, "chunks", file.id), { recursive: true, force: true }).catch(() => undefined);
      }));
      await prisma.fileEntry.deleteMany({ where: { id: { in: removedFiles.map((file) => file.id) } } });
    }

    const toInsert: any[] = [];
    const toUpdate: { id: string; data: any; version?: any }[] = [];

    for (const f of validFiles) {
      const existing = existingMap.get(f.path);
      const format = f.sizeBytes > DeviceHub.CHUNKED_THRESHOLD ? "chunked" : "single";
      const isTrashed = Boolean(f.isTrashed);

      if (!existing) {
        toInsert.push({
          deviceId,
          path: f.path,
          name: f.name,
          sizeBytes: f.sizeBytes,
          contentHash: f.contentHash,
          mimeType: f.mimeType ?? null,
          encryptedDek: f.encryptedDek,
          encryptionFormat: format,
          isCached: false,
          cachedContentHash: null,
          deletedAt: isTrashed ? new Date() : null,
        });
      } else {
        const contentHashChanged = existing.contentHash !== f.contentHash;
        const targetDeletedAt = isTrashed ? (existing.deletedAt ?? new Date()) : null;
        const metadataChanged =
          contentHashChanged ||
          existing.sizeBytes !== f.sizeBytes ||
          existing.name !== f.name ||
          existing.mimeType !== (f.mimeType ?? null) ||
          existing.encryptedDek !== f.encryptedDek ||
          (existing.deletedAt === null) !== (targetDeletedAt === null);

        if (metadataChanged) {
          const updateData: any = {
            name: f.name,
            sizeBytes: f.sizeBytes,
            contentHash: f.contentHash,
            mimeType: f.mimeType ?? null,
            encryptedDek: f.encryptedDek,
            encryptionFormat: format,
            deletedAt: targetDeletedAt,
          };

          let versionData: any = null;
          if (contentHashChanged && existing.contentHash !== "directory" && !isTrashed) {
            versionData = {
              fileId: existing.id,
              deviceId,
              path: existing.path,
              name: existing.name,
              sizeBytes: existing.sizeBytes,
              contentHash: existing.contentHash,
              mimeType: existing.mimeType,
              encryptedDek: existing.encryptedDek,
              cacheKey: existing.cacheKey,
            };
            updateData.isCached = false;
            updateData.cacheKey = null;
            updateData.cachedAt = null;
            updateData.cachedContentHash = null;
          }

          toUpdate.push({ id: existing.id, data: updateData, version: versionData });
        }
      }
    }

    // Execute bulk insertions in batches of 500
    const BATCH_SIZE = 500;
    for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
      const batch = toInsert.slice(i, i + BATCH_SIZE);
      await prisma.fileEntry.createMany({
        data: batch,
      });
    }

    // Execute updates in parallel chunks with transactions
    for (let i = 0; i < toUpdate.length; i += BATCH_SIZE) {
      const batch = toUpdate.slice(i, i + BATCH_SIZE);
      const ops = batch.flatMap((item) => {
        const list: any[] = [
          prisma.fileEntry.update({
            where: { id: item.id },
            data: item.data,
          }),
        ];
        if (item.version) {
          list.push(prisma.fileVersion.create({ data: item.version }));
        }
        return list;
      });
      await prisma.$transaction(ops);
    }
  }

  public async handleFileDelta(deviceId: string, delta: { action: "create" | "update" | "delete" | "trash" | "restore" | "permanent_delete"; file: any }) {
    if (!delta || !delta.file || typeof delta.file.path !== "string") return;
    const { action, file } = delta;

    if (action === "trash") {
      await prisma.fileEntry.updateMany({
        where: { deviceId, path: file.path },
        data: { deletedAt: new Date() },
      });
      return;
    }

    if (action === "restore") {
      await prisma.fileEntry.updateMany({
        where: { deviceId, path: file.path },
        data: { deletedAt: null },
      });
      return;
    }

    if (action === "delete" || action === "permanent_delete") {
      const existing = await prisma.fileEntry.findUnique({
        where: { deviceId_path: { deviceId, path: file.path } },
      });
      if (existing) {
        const cacheName = existing.cacheKey ?? `${existing.id}.bin`;
        await fs.promises.unlink(path.join(config.storageDir, cacheName)).catch(() => undefined);
        await fs.promises.rm(path.join(config.storageDir, "chunks", existing.id), { recursive: true, force: true }).catch(() => undefined);
        await prisma.fileEntry.delete({ where: { id: existing.id } });
      }
      return;
    }

    const format = (file.sizeBytes ?? 0) > DeviceHub.CHUNKED_THRESHOLD ? "chunked" : "single";
    await prisma.fileEntry.upsert({
      where: { deviceId_path: { deviceId, path: file.path } },
      create: {
        deviceId,
        path: file.path,
        name: file.name ?? path.basename(file.path),
        sizeBytes: file.sizeBytes ?? 0,
        contentHash: file.contentHash ?? "",
        mimeType: file.mimeType ?? null,
        encryptedDek: file.encryptedDek ?? "",
        encryptionFormat: format,
        isCached: false,
      },
      update: {
        name: file.name ?? path.basename(file.path),
        sizeBytes: file.sizeBytes ?? 0,
        contentHash: file.contentHash ?? "",
        mimeType: file.mimeType ?? null,
        encryptedDek: file.encryptedDek ?? "",
        encryptionFormat: format,
        deletedAt: null,
      },
    });
  }

  private handleFetchResult(msg: any) {
    const pending = this.pending.get(msg.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(msg.requestId);

    if (msg.ok) {
      pending.resolve(Buffer.from(msg.dataBase64, "base64"));
    } else {
      pending.reject(new Error(msg.error ?? "Device reported an error"));
    }
  }

  private handleUploadResult(msg: any) {
    const pending = this.pendingUploads.get(msg.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingUploads.delete(msg.requestId);
    if (msg.ok) pending.resolve();
    else pending.reject(new Error(msg.error ?? "Device rejected the upload"));
  }

  private handleDeleteResult(msg: any) {
    const pending = this.pendingDeletes.get(msg.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingDeletes.delete(msg.requestId);
    if (msg.ok) pending.resolve();
    else pending.reject(new Error(msg.error ?? "Device could not delete file"));
  }

  private handleTrashResult(msg: any) {
    const pending = this.pendingTrash.get(msg.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingTrash.delete(msg.requestId);
    if (msg.ok) pending.resolve();
    else pending.reject(new Error(msg.error ?? "Device recycle bin operation failed"));
  }

  private handleSyncResult(msg: any) {
    const pending = this.pendingSyncs.get(msg.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingSyncs.delete(msg.requestId);
    if (msg.ok) pending.resolve();
    else pending.reject(new Error(msg.error ?? "Device could not sync storage"));
  }

  private handleFolderResult(msg: any) {
    const pending = this.pendingFolders.get(msg.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingFolders.delete(msg.requestId);
    if (msg.ok) pending.resolve();
    else pending.reject(new Error(msg.error ?? "Device rejected folder operation"));
  }

  /** Ask a connected phone for a file's ciphertext. Rejects if offline or on timeout. */
  async requestFile(deviceId: string, path: string): Promise<Buffer> {
    const socket = this.sockets.get(deviceId);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("DEVICE_OFFLINE");
    }

    const requestId = uuid();
    const result = new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("DEVICE_TIMEOUT"));
      }, config.deviceFetchTimeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
    });

    socket.send(JSON.stringify({ type: "fetch_request", requestId, path }));
    return result;
  }

  /**
   * Request a single chunk of a file from the phone. The phone reads `length`
   * bytes starting at `offset`, encrypts the chunk independently (its own
   * AES-GCM IV), and returns it as a binary WS frame.
   */
  async requestChunk(
    deviceId: string,
    filePath: string,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const socket = this.sockets.get(deviceId);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("DEVICE_OFFLINE");
    }

    const requestId = uuid();
    const result = new Promise<Buffer>((resolve, reject) => {
      const cancel = () => {
        clearTimeout(timer);
        this.pendingChunks.delete(requestId);
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "cancel_request", requestId }));
        }
        reject(new Error("REQUEST_CANCELLED"));
      };
      const timer = setTimeout(() => {
        this.pendingChunks.delete(requestId);
        signal?.removeEventListener("abort", cancel);
        reject(new Error("DEVICE_TIMEOUT"));
      }, config.deviceFetchTimeoutMs);
      if (signal?.aborted) {
        cancel();
        return;
      }
      signal?.addEventListener("abort", cancel, { once: true });
      this.pendingChunks.set(requestId, { resolve, reject, timer });
    });

    socket.send(JSON.stringify({ type: "fetch_chunk", requestId, path: filePath, offset, length }));
    return result;
  }

  private thumbnailSemaphores = new Map<string, { active: number; queue: (() => void)[] }>();

  private acquireThumbnailSlot(deviceId: string): Promise<() => void> {
    const sem = this.thumbnailSemaphores.get(deviceId) ?? { active: 0, queue: [] };
    this.thumbnailSemaphores.set(deviceId, sem);
    const MAX_CONCURRENT = 4;

    return new Promise((resolve) => {
      const run = () => {
        sem.active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          sem.active--;
          const next = sem.queue.shift();
          if (next) next();
        });
      };

      if (sem.active < MAX_CONCURRENT) {
        run();
      } else {
        sem.queue.push(run);
      }
    });
  }

  /**
   * Request a thumbnail on-demand from the phone. The phone generates the
   * thumbnail, encrypts it with the file's DEK, and returns it as a binary
   * WS frame. Throttled to max 4 concurrent requests per device to avoid
   * congesting the phone socket.
   */
  async requestThumbnail(deviceId: string, filePath: string): Promise<Buffer> {
    const socket = this.sockets.get(deviceId);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("DEVICE_OFFLINE");
    }

    const releaseSlot = await this.acquireThumbnailSlot(deviceId);
    const requestId = uuid();

    try {
      const result = await new Promise<Buffer>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingThumbnails.delete(requestId);
          reject(new Error("DEVICE_TIMEOUT"));
        }, config.deviceFetchTimeoutMs);
        this.pendingThumbnails.set(requestId, { resolve, reject, timer });
        socket.send(JSON.stringify({ type: "thumbnail_request", requestId, path: filePath }));
      });
      return result;
    } finally {
      releaseSlot();
    }
  }

  /**
   * Handle binary WS frames from the phone.
   *
   * Format (38+ bytes):
   *   [36-byte requestId UTF-8][1-byte type: 0x01=chunk, 0x02=thumbnail][1-byte status: 0x01=ok, 0x00=error][payload]
   *
   * The type byte at position 36 distinguishes chunk data from thumbnail data
   * so the correct pending-promise map is resolved.
   */
  private handleBinaryMessage(deviceId: string, data: Buffer) {
    if (data.length < 38) return; // too short
    const requestId = data.subarray(0, 36).toString("utf-8");
    const frameType = data[36]; // 0x01 = chunk, 0x02 = thumbnail
    const status = data[37];
    const payload = data.subarray(38);

    if (frameType === 0x02) {
      // Thumbnail response
      const pending = this.pendingThumbnails.get(requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pendingThumbnails.delete(requestId);
      if (status === 1 && payload.length > 0) {
        pending.resolve(payload);
      } else {
        pending.reject(new Error("Device returned empty or error thumbnail"));
      }
    } else {
      // Chunk response (0x01 or legacy)
      const pending = this.pendingChunks.get(requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pendingChunks.delete(requestId);
      if (status === 1 && payload.length > 0) {
        pending.resolve(payload);
      } else {
        pending.reject(new Error("Device returned empty or error chunk"));
      }
    }
  }

  async uploadFile(deviceId: string, path: string, dataBase64: string, encryptedDek: string): Promise<void> {
    const socket = this.sockets.get(deviceId);
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("DEVICE_OFFLINE");

    const requestId = uuid();
    const timeoutMs = Math.max(60000, config.deviceFetchTimeoutMs * 2);
    const result = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingUploads.delete(requestId);
        reject(new Error("DEVICE_TIMEOUT"));
      }, timeoutMs);
      this.pendingUploads.set(requestId, { resolve, reject, timer });
    });

    socket.send(JSON.stringify({ type: "upload_request", requestId, path, dataBase64, encryptedDek }));
    return result;
  }

  async uploadChunkedFile(deviceId: string, path: string, chunks: Buffer[], encryptedDek: string, totalBytes: number, totalChunks: number): Promise<void> {
    const socket = this.sockets.get(deviceId);
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("DEVICE_OFFLINE");
    const uploadId = uuid();
    const completionTimeout = Math.max(60000, totalChunks * 8000);
    const sendAndWait = (message: any, timeoutMs: number = 45000) => {
      const requestId = uuid();
      const result = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingUploads.delete(requestId);
          reject(new Error("DEVICE_TIMEOUT"));
        }, timeoutMs);
        this.pendingUploads.set(requestId, { resolve, reject, timer });
      });
      socket.send(JSON.stringify({ ...message, requestId }));
      return result;
    };
    await sendAndWait({ type: "upload_start", uploadId, path, encryptedDek, totalBytes, totalChunks }, 30000);
    for (let index = 0; index < chunks.length; index++) {
      await sendAndWait({ type: "upload_chunk", uploadId, chunkIndex: index, dataBase64: chunks[index].toString("base64") }, 45000);
    }
    await sendAndWait({ type: "upload_complete", uploadId }, completionTimeout);
  }

  async deleteFile(deviceId: string, path: string, permanent: boolean = false): Promise<void> {
    const socket = this.sockets.get(deviceId);
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("DEVICE_OFFLINE");

    const requestId = uuid();
    const result = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingDeletes.delete(requestId);
        reject(new Error("DEVICE_TIMEOUT"));
      }, config.deviceFetchTimeoutMs);
      this.pendingDeletes.set(requestId, { resolve, reject, timer });
    });

    socket.send(JSON.stringify({ type: "delete_request", requestId, path, permanent }));
    return result;
  }

  async trashOperation(deviceId: string, path: string, action: "trash" | "restore" | "permanent"): Promise<void> {
    const socket = this.sockets.get(deviceId);
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("DEVICE_OFFLINE");

    const requestId = uuid();
    const result = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingTrash.delete(requestId);
        reject(new Error("DEVICE_TIMEOUT"));
      }, config.deviceFetchTimeoutMs);
      this.pendingTrash.set(requestId, { resolve, reject, timer });
    });

    socket.send(JSON.stringify({ type: "trash_request", requestId, path, action }));
    return result;
  }

  async requestSync(deviceId: string): Promise<void> {
    const socket = this.sockets.get(deviceId);
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("DEVICE_OFFLINE");

    const requestId = uuid();
    const result = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingSyncs.delete(requestId);
        reject(new Error("DEVICE_TIMEOUT"));
      }, config.deviceFetchTimeoutMs);
      this.pendingSyncs.set(requestId, { resolve, reject, timer });
    });

    socket.send(JSON.stringify({ type: "sync_request", requestId }));
    return result;
  }

  async folderOperation(deviceId: string, operation: "create" | "move" | "rename", path: string, destination?: string): Promise<void> {
    const socket = this.sockets.get(deviceId);
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("DEVICE_OFFLINE");
    const requestId = uuid();
    const result = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingFolders.delete(requestId);
        reject(new Error("DEVICE_TIMEOUT"));
      }, config.deviceFetchTimeoutMs);
      this.pendingFolders.set(requestId, { resolve, reject, timer });
    });
    socket.send(JSON.stringify({ type: "folder_request", requestId, operation, path, source: path, destination }));
    return result;
  }
}

// Single shared hub instance.
export const deviceHub = new DeviceHub();
