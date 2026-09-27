import { WebSocket } from "ws";
import { v4 as uuid } from "uuid";
import { config } from "../config";
import { prisma } from "../db";

// --- Wire protocol between broker <-> phone app (over one persistent WS) ---
//
// Phone -> Broker:
//   { type: "hello", deviceId }
//   { type: "file_sync", files: [{ path, name, sizeBytes, contentHash, mimeType, encryptedDek }] }
//   { type: "fetch_result", requestId, ok: true, dataBase64 }
//   { type: "fetch_result", requestId, ok: false, error }
//
// Broker -> Phone:
//   { type: "fetch_request", requestId, path }
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

class DeviceHub {
  private sockets = new Map<string, WebSocket>(); // deviceId -> socket
  private pending = new Map<string, PendingFetch>(); // requestId -> pending fetch

  isOnline(deviceId: string): boolean {
    return this.sockets.has(deviceId);
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
        break;
      case "fetch_result":
        this.handleFetchResult(msg);
        break;
      default:
        break;
    }
  }

  private async handleFileSync(deviceId: string, files: any[]) {
    for (const f of files) {
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
}

// Single shared hub instance.
export const deviceHub = new DeviceHub();