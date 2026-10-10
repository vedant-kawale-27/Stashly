/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

import { Server as HttpServer } from "http";
import { WebSocketServer } from "ws";
import { verifyDeviceToken, verifyUserToken } from "../auth";
import { clientHub } from "./clientHub";
import { deviceHub } from "./deviceHub";
import { prisma } from "../db";
import { isPathAllowed } from "../access";
import { WebSocket } from "ws";

const TRANSFER_CHUNK_SIZE = 1024 * 1024;

/**
 * Browser transfer protocol:
 *   client -> server: {"type":"download","fileId":"..."}
 *   server -> client: {"type":"download_ready",...}
 *   server -> client binary: [type=1][sequence:u32][length:u32][ciphertext]
 *   server -> client binary: [type=2][sequence:u32] (end)
 *
 * Ciphertext is opaque: it is still encrypted by the Android vault. Keeping
 * the transfer socket separate from /ws/client avoids exposing device events
 * to a browser transfer and keeps the HTTP download path unchanged.
 */
async function streamTransferDownload(userId: string, ws: WebSocket, msg: any, abort: AbortController) {
  if (typeof msg.fileId !== "string") {
    ws.send(JSON.stringify({ type: "error", code: "INVALID_REQUEST", error: "fileId is required" }));
    return;
  }
  const file = await prisma.fileEntry.findUnique({ where: { id: msg.fileId } });
  if (!file) {
    ws.send(JSON.stringify({ type: "error", code: "NOT_FOUND", error: "File not found" }));
    return;
  }
  const link = await prisma.userDevice.findUnique({
    where: { userId_deviceId: { userId, deviceId: file.deviceId } },
    include: { device: { select: { sharingPaused: true } } },
  });
  if (!link || !isPathAllowed(file.path, link)) {
    ws.send(JSON.stringify({ type: "error", code: "FORBIDDEN", error: "File not accessible" }));
    return;
  }
  if (link.device.sharingPaused) {
    ws.send(JSON.stringify({ type: "error", code: "SHARING_PAUSED", error: "Sharing is paused by the device owner" }));
    return;
  }
  if (!deviceHub.isOnline(file.deviceId)) {
    ws.send(JSON.stringify({ type: "error", code: "DEVICE_OFFLINE", error: "Device is offline" }));
    return;
  }

  const totalChunks = Math.ceil(file.sizeBytes / TRANSFER_CHUNK_SIZE);
  ws.send(JSON.stringify({
    type: "download_ready",
    fileId: file.id,
    wrappedDek: file.encryptedDek,
    totalBytes: file.sizeBytes,
    chunkSize: TRANSFER_CHUNK_SIZE,
    totalChunks,
  }));

  for (let sequence = 0; sequence < totalChunks; sequence++) {
    if (abort.signal.aborted || ws.readyState !== WebSocket.OPEN) return;
    const offset = sequence * TRANSFER_CHUNK_SIZE;
    const length = Math.min(TRANSFER_CHUNK_SIZE, file.sizeBytes - offset);
    const ciphertext = await deviceHub.requestChunk(file.deviceId, file.path, offset, length, abort.signal);
    if (abort.signal.aborted || ws.readyState !== WebSocket.OPEN) return;
    const frame = Buffer.allocUnsafe(9 + ciphertext.length);
    frame[0] = 1;
    frame.writeUInt32BE(sequence, 1);
    frame.writeUInt32BE(ciphertext.length, 5);
    ciphertext.copy(frame, 9);
    ws.send(frame);
  }
  if (!abort.signal.aborted && ws.readyState === WebSocket.OPEN) {
    const end = Buffer.alloc(5);
    end[0] = 2;
    end.writeUInt32BE(totalChunks, 1);
    ws.send(end);
  }
}

/**
 * Phones connect to: wss://<broker>/ws/device
 * The device JWT is passed via Authorization header, Sec-WebSocket-Protocol, or query param.
 */
export function attachWebSocketServer(httpServer: HttpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "", "http://localhost");
    if (url.pathname !== "/ws/device" && url.pathname !== "/ws/client" && url.pathname !== "/ws/transfer") {
      socket.destroy();
      return;
    }

    const authHeader = req.headers.authorization;
    const headerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
    const protoToken = req.headers["sec-websocket-protocol"]?.split(",")[0]?.trim();
    const queryToken = url.searchParams.get("token")?.trim();
    const token = headerToken || protoToken || queryToken;

    if (!token) {
      socket.destroy();
      return;
    }

    try {
      if (url.pathname === "/ws/client") {
        const { userId } = verifyUserToken(token);
        wss.handleUpgrade(req, socket, head, (ws) => {
          clientHub.registerConnection(userId, ws);
        });
        return;
      }

      if (url.pathname === "/ws/transfer") {
        const { userId } = verifyUserToken(token);
        wss.handleUpgrade(req, socket, head, (ws) => {
          const abort = new AbortController();
          let active = false;
          ws.on("close", () => abort.abort());
          ws.on("message", (raw, isBinary) => {
            if (isBinary || active) return;
            let msg: any;
            try { msg = JSON.parse(raw.toString()); } catch {
              ws.send(JSON.stringify({ type: "error", code: "INVALID_REQUEST", error: "Invalid JSON" }));
              return;
            }
            if (msg.type !== "download") {
              ws.send(JSON.stringify({ type: "error", code: "INVALID_REQUEST", error: "Only download is supported" }));
              return;
            }
            active = true;
            streamTransferDownload(userId, ws, msg, abort).catch((err) => {
              if (ws.readyState === WebSocket.OPEN && !abort.signal.aborted) {
                ws.send(JSON.stringify({ type: "error", code: "TRANSFER_FAILED", error: err?.message ?? "Transfer failed" }));
              }
              ws.close(1011, "transfer failed");
            });
          });
        });
        return;
      }

      const { deviceId } = verifyDeviceToken(token);
      wss.handleUpgrade(req, socket, head, (ws) => {
        deviceHub.registerConnection(deviceId, ws);
      });
    } catch {
      socket.destroy();
      return;
    }
  });

  return wss;
}
