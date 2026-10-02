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

export interface DeviceTelemetry {
  modelName: string | null;
  modelNumber: string | null;
  androidVersion: string | null;
  osVersion: string | null;
  appVersion: string | null;
  batteryLevel: number | null;
  storageTotalMb: number | null;
  storageFreeMb: number | null;
}

class DeviceHub {
  private sockets = new Map<string, WebSocket>(); // deviceId -> socket
  private pending = new Map<string, PendingFetch>(); // requestId -> pending fetch
  private pendingUploads = new Map<string, PendingUpload>();
  private pendingDeletes = new Map<string, PendingDelete>();
  private pendingTrash = new Map<string, PendingTrash>();
  private pendingSyncs = new Map<string, PendingSync>();
  private pendingFolders = new Map<string, PendingFolder>();
  private clientPresence = new Map<string, number>(); // deviceId:userId -> last web heartbeat
  private clientOnlineState = new Map<string, boolean>(); // deviceId:userId -> explicit online status
  private telemetry = new Map<string, DeviceTelemetry>(); // live only; intentionally never persisted

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
      } catch {}
      setTimeout(() => {
        try {
          socket.close(4004, reason);
        } catch {}
        this.sockets.delete(deviceId);
      }, 200);
    }
  }

  notifyClientRemoved(deviceId: string, userId: string) {
    const socket = this.sockets.get(deviceId);
    if (socket?.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ type: "client_unlinked", userId }));
      } catch {}
    }
  }

  notifyClientPresence(deviceId: string, userId: string, online: boolean) {
    const socket = this.sockets.get(deviceId);
    if (socket?.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ type: "client_presence", userId, online }));
      } catch {}
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
    socket.on("message", (raw) => this.handleMessage(deviceId, raw.toString()));
    socket.on("close", () => this.handleDisconnect(deviceId, socket));
  }

  private async handleDisconnect(deviceId: string, socket: WebSocket) {
    if (this.sockets.get(deviceId) !== socket) return; // already replaced
    this.sockets.delete(deviceId);
    await this.clearDeviceFiles(deviceId);
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
          this.sockets.get(deviceId)?.send(JSON.stringify({
            type: "sync_result",
            requestId: msg.syncRequestId,
            ok: true,
          }));
        }
        break;
      case "hello":
        await this.handleHello(deviceId, msg);
        break;
      case "node_stop":
        await this.handleNodeStop(deviceId);
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
    this.updateDeviceTelemetry(deviceId, {
      ...(typeof msg.modelName === "string" ? { modelName: msg.modelName } : {}),
      ...(typeof msg.modelNumber === "string" ? { modelNumber: msg.modelNumber } : {}),
      ...(typeof msg.androidVersion === "string" ? { androidVersion: msg.androidVersion } : {}),
      ...(typeof msg.osVersion === "string" ? { osVersion: msg.osVersion } : {}),
      ...(typeof msg.appVersion === "string" ? { appVersion: msg.appVersion } : {}),
      ...(Number.isInteger(msg.batteryLevel) ? { batteryLevel: msg.batteryLevel } : {}),
      ...(Number.isInteger(msg.storageTotalMb) ? { storageTotalMb: msg.storageTotalMb } : {}),
      ...(Number.isInteger(msg.storageFreeMb) ? { storageFreeMb: msg.storageFreeMb } : {}),
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
      return fs.promises.unlink(path.join(config.storageDir, cacheName)).catch(() => undefined);
    }));
    await prisma.fileEntry.deleteMany({ where: { deviceId, deletedAt: null } });
  }

  private async handleFileSync(deviceId: string, files: any[]) {
    const validFiles = files.filter((file) =>
      file && typeof file.path === "string" && typeof file.name === "string" &&
      typeof file.sizeBytes === "number" && typeof file.contentHash === "string" &&
      typeof file.encryptedDek === "string"
    );
    const incomingPaths = new Set(validFiles.map((file) => file.path));
    const existingFiles = await prisma.fileEntry.findMany({
      where: { deviceId, deletedAt: null },
      select: { id: true, path: true, cacheKey: true },
    });
    const removedFiles = existingFiles.filter((file) => !incomingPaths.has(file.path));

    await Promise.all(removedFiles.map((file) => {
      const cacheName = file.cacheKey ?? `${file.id}.bin`;
      return fs.promises.unlink(path.join(config.storageDir, cacheName)).catch(() => undefined);
    }));
    if (removedFiles.length > 0) {
      await prisma.fileEntry.deleteMany({ where: { id: { in: removedFiles.map((file) => file.id) } } });
    }

    for (const f of validFiles) {
      const existing = await prisma.fileEntry.findUnique({ where: { deviceId_path: { deviceId, path: f.path } } });
      if (existing && existing.contentHash !== f.contentHash && existing.contentHash !== "directory") {
        await prisma.fileVersion.create({
          data: {
            fileId: existing.id, deviceId, path: existing.path, name: existing.name,
            sizeBytes: existing.sizeBytes, contentHash: existing.contentHash,
            mimeType: existing.mimeType, encryptedDek: existing.encryptedDek, cacheKey: existing.cacheKey,
          },
        });
      }
      await prisma.fileEntry.upsert({
        where: { deviceId_path: { deviceId, path: f.path } },
        create: {
          deviceId,
          path: f.path,
          name: f.name,
          sizeBytes: f.sizeBytes,
          contentHash: f.contentHash,
          mimeType: f.mimeType ?? null,
          encryptedDek: f.encryptedDek,
        },
        update: {
          name: f.name,
          sizeBytes: f.sizeBytes,
          contentHash: f.contentHash,
          mimeType: f.mimeType ?? null,
          encryptedDek: f.encryptedDek,
          deletedAt: null,
        },
      });
    }
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

  async uploadFile(deviceId: string, path: string, dataBase64: string, encryptedDek: string): Promise<void> {
    const socket = this.sockets.get(deviceId);
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("DEVICE_OFFLINE");

    const requestId = uuid();
    const result = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingUploads.delete(requestId);
        reject(new Error("DEVICE_TIMEOUT"));
      }, config.deviceFetchTimeoutMs);
      this.pendingUploads.set(requestId, { resolve, reject, timer });
    });

    socket.send(JSON.stringify({ type: "upload_request", requestId, path, dataBase64, encryptedDek }));
    return result;
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
