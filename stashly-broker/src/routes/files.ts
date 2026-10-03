/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

import { Router } from "express";
import fs from "fs";
import path from "path";
import { config } from "../config";
import { prisma } from "../db";
import { AuthedRequest, requireAuth } from "../middleware";
import { deviceHub } from "../ws/deviceHub";
import { isPathAllowed } from "../access";

export const filesRouter = Router();

function normalizeUploadPath(directory: string, name: string): string | null {
  const cleanDirectory = directory.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
  const cleanName = name.replace(/\\/g, "/").split("/").pop()?.trim() ?? "";
  if (!cleanName || cleanName === "." || cleanName === ".." || cleanName.includes("\0") || cleanDirectory.split("/").includes("..")) return null;
  return `/${[cleanDirectory, cleanName].filter(Boolean).join("/")}`;
}

async function assertCanAccessDevice(userId: string, deviceId: string) {
  const link = await prisma.userDevice.findUnique({
    where: { userId_deviceId: { userId, deviceId } },
    include: { device: true },
  });
  if (!link) return null;
  return link;
}

// GET /files?deviceId=... — list metadata (never file content) for the user's accessible device(s).
filesRouter.get("/", requireAuth, async (req: AuthedRequest, res) => {
  const deviceId = req.query.deviceId as string | undefined;
  const isTrash = req.query.trash === "true";

  const userDevices = await prisma.userDevice.findMany({
    where: { userId: req.user!.userId, ...(deviceId ? { deviceId } : {}) },
    select: { deviceId: true, scopeMode: true, scopePath: true, sharingEnabled: true },
  });
  const deviceIds = userDevices.map((ud) => ud.deviceId);

  if (deviceIds.length === 0) {
    return res.json([]);
  }

  const files = await prisma.fileEntry.findMany({
    where: {
      deviceId: { in: deviceIds },
      deletedAt: isTrash ? { not: null } : null,
    },
    orderBy: { path: "asc" },
  });

  const linksByDevice = new Map(userDevices.map((link) => [link.deviceId, link]));
  return res.json(
    files.filter((f) => {
      const link = linksByDevice.get(f.deviceId);
      return link ? isPathAllowed(f.path, link) : false;
    }).map((f) => ({
      ...f,
      deviceOnline: deviceHub.isOnline(f.deviceId),
      // Thumbnails are generated on-demand by Android for image/video files
      hasThumbnail: (f.mimeType?.startsWith("image/") || f.mimeType?.startsWith("video/")) && deviceHub.isOnline(f.deviceId),
      encryptionFormat: (f as any).encryptionFormat ?? "single",
    }))
  );
});

// GET /files/:id/thumbnail — request encrypted thumbnail live from the Android device
filesRouter.get("/:id/thumbnail", requireAuth, async (req: AuthedRequest, res) => {
  const file = await prisma.fileEntry.findUnique({ where: { id: req.params.id } });
  if (!file) return res.status(404).json({ error: "File not found" });

  const link = await assertCanAccessDevice(req.user!.userId, file.deviceId);
  if (!link || !isPathAllowed(file.path, link)) return res.status(404).json({ error: "File not accessible" });

  if (!deviceHub.isOnline(file.deviceId)) {
    return res.status(503).json({ error: "Device offline — thumbnail unavailable" });
  }

  try {
    const thumbData = await deviceHub.requestThumbnail(file.deviceId, file.path);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("X-Encrypted-Dek", file.encryptedDek);
    res.setHeader("Cache-Control", "no-store"); // don't HTTP-cache — thumbnails must be inaccessible when device goes offline
    return res.send(thumbData);
  } catch {
    return res.status(504).json({ error: "Thumbnail not available from device" });
  }
});

// Start a chunked upload. Chunks are opaque ciphertext and are never decrypted by the broker.
filesRouter.post("/uploads", requireAuth, async (req: AuthedRequest, res) => {
  const { deviceId, path: directory, name, mimeType, encryptedDek, totalBytes } = req.body ?? {};
  if (
    typeof deviceId !== "string" ||
    typeof directory !== "string" ||
    typeof name !== "string" ||
    typeof encryptedDek !== "string" ||
    !Number.isInteger(totalBytes) ||
    totalBytes <= 0 ||
    totalBytes > 40 * 1024 * 1024
  ) {
    return res.status(400).json({ error: "deviceId, path, name, encryptedDek and positive totalBytes are required" });
  }

  const link = await assertCanAccessDevice(req.user!.userId, deviceId);
  const targetPath = normalizeUploadPath(directory, name);
  if (!link || !link.sharingEnabled || !targetPath || !isPathAllowed(directory || "/", link)) {
    return res.status(403).json({ error: "Upload destination is not allowed" });
  }

  const session = await prisma.uploadSession.create({
    data: {
      userId: req.user!.userId,
      deviceId,
      path: targetPath,
      name,
      mimeType: mimeType ?? null,
      encryptedDek,
      totalBytes,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });

  await fs.promises.mkdir(path.join(config.storageDir, "uploads"), { recursive: true });
  return res.status(201).json({ uploadId: session.id, receivedBytes: 0, totalBytes });
});

filesRouter.post("/uploads/:uploadId/chunks", requireAuth, async (req: AuthedRequest, res) => {
  const session = await prisma.uploadSession.findFirst({
    where: { id: req.params.uploadId, userId: req.user!.userId },
  });
  if (!session || session.expiresAt < new Date()) {
    return res.status(404).json({ error: "Upload session not found or expired" });
  }

  const { dataBase64, offset } = req.body ?? {};
  if (typeof dataBase64 !== "string" || !Number.isInteger(offset) || offset !== session.receivedBytes) {
    return res.status(400).json({ error: "dataBase64 and the next sequential offset are required", receivedBytes: session.receivedBytes });
  }

  const chunk = Buffer.from(dataBase64, "base64");
  if (!chunk.length || session.receivedBytes + chunk.length > session.totalBytes) {
    return res.status(400).json({ error: "Invalid chunk size" });
  }

  const chunkPath = path.join(config.storageDir, "uploads", `${session.id}.bin`);
  await fs.promises.appendFile(chunkPath, chunk);

  const updated = await prisma.uploadSession.update({
    where: { id: session.id },
    data: { receivedBytes: { increment: chunk.length }, chunkCount: { increment: 1 } },
  });

  if (updated.receivedBytes < updated.totalBytes) {
    return res.json({ uploadId: session.id, receivedBytes: updated.receivedBytes, complete: false });
  }

  try {
    const payload = await fs.promises.readFile(chunkPath);
    await deviceHub.uploadFile(session.deviceId, session.path, payload.toString("base64"), session.encryptedDek);
    await fs.promises.unlink(chunkPath).catch(() => {});
    await prisma.uploadSession.delete({ where: { id: session.id } });
    return res.json({ uploadId: session.id, receivedBytes: updated.receivedBytes, complete: true, path: session.path });
  } catch (err: any) {
    return res.status(err?.message === "DEVICE_OFFLINE" ? 503 : 504).json({ error: err?.message ?? "Device upload failed" });
  }
});

filesRouter.get("/:id/versions", requireAuth, async (req: AuthedRequest, res) => {
  const file = await prisma.fileEntry.findUnique({ where: { id: req.params.id } });
  if (!file) return res.status(404).json({ error: "File not found" });

  const link = await assertCanAccessDevice(req.user!.userId, file.deviceId);
  if (!link || !isPathAllowed(file.path, link)) return res.status(404).json({ error: "File not accessible" });

  const versions = await prisma.fileVersion.findMany({
    where: { fileId: file.id },
    orderBy: { createdAt: "desc" },
  });
  return res.json(versions);
});

filesRouter.post("/:id/restore", requireAuth, async (req: AuthedRequest, res) => {
  const file = await prisma.fileEntry.findUnique({ where: { id: req.params.id } });
  if (!file) return res.status(404).json({ error: "File not found" });

  const link = await assertCanAccessDevice(req.user!.userId, file.deviceId);
  if (!link || !link.sharingEnabled || !isPathAllowed(file.path, link)) {
    return res.status(403).json({ error: "Permission denied" });
  }

  try {
    if (deviceHub.isOnline(file.deviceId)) {
      await deviceHub.trashOperation(file.deviceId, file.path, "restore");
    }
    const restored = await prisma.fileEntry.update({
      where: { id: file.id },
      data: { deletedAt: null },
    });
    return res.json(restored);
  } catch (err: any) {
    const offline = err?.message === "DEVICE_OFFLINE";
    return res.status(offline ? 503 : 504).json({
      error: offline ? "The Android node is offline" : (err?.message || "Failed to restore file on device"),
      code: offline ? "DEVICE_OFFLINE" : "DEVICE_TIMEOUT",
    });
  }
});

filesRouter.post("/folders", requireAuth, async (req: AuthedRequest, res) => {
  const { deviceId, path: folderPath } = req.body ?? {};
  if (
    typeof deviceId !== "string" ||
    typeof folderPath !== "string" ||
    !folderPath.startsWith("/") ||
    folderPath.includes("..")
  ) {
    return res.status(400).json({ error: "deviceId and a valid folder path are required" });
  }

  const link = await assertCanAccessDevice(req.user!.userId, deviceId);
  if (!link || !link.sharingEnabled || !isPathAllowed(folderPath, link)) {
    return res.status(403).json({ error: "Permission denied" });
  }

  try {
    await deviceHub.folderOperation(deviceId, "create", folderPath);
    return res.status(201).json({ ok: true, path: folderPath });
  } catch (err: any) {
    return res.status(err?.message === "DEVICE_OFFLINE" ? 503 : 504).json({ error: err?.message ?? "Folder create failed" });
  }
});

filesRouter.patch("/:id", requireAuth, async (req: AuthedRequest, res) => {
  const file = await prisma.fileEntry.findUnique({ where: { id: req.params.id } });
  const destination = req.body?.path;
  if (!file || typeof destination !== "string" || !destination.startsWith("/") || destination.includes("..")) {
    return res.status(400).json({ error: "File and valid destination path are required" });
  }

  const link = await assertCanAccessDevice(req.user!.userId, file.deviceId);
  if (!link || !link.sharingEnabled || !isPathAllowed(file.path, link) || !isPathAllowed(destination, link)) {
    return res.status(403).json({ error: "Permission denied" });
  }

  try {
    await deviceHub.folderOperation(file.deviceId, "move", file.path, destination);
    const isFolder = file.mimeType === "inode/directory" || file.contentHash === "directory";
    if (isFolder) {
      const descendants = await prisma.fileEntry.findMany({
        where: { deviceId: file.deviceId, path: { startsWith: `${file.path}/` } },
        select: { id: true, path: true },
      });
      for (const child of descendants) {
        await prisma.fileEntry.update({
          where: { id: child.id },
          data: { path: `${destination}${child.path.slice(file.path.length)}` },
        });
      }
    }
    const updated = await prisma.fileEntry.update({
      where: { id: file.id },
      data: { path: destination, name: path.basename(destination), deletedAt: null },
    });
    return res.json(updated);
  } catch (err: any) {
    return res.status(err?.message === "DEVICE_OFFLINE" ? 503 : 504).json({ error: err?.message ?? "Move failed" });
  }
});

// GET /files/:id/download — fetch ciphertext, live from the phone.
// ?stream=chunked → stream in 1MB chunks (broker never buffers full file)
// default → legacy full-file fetch (backward compatible)
filesRouter.get("/:id/download", requireAuth, async (req: AuthedRequest, res) => {
  const file = await prisma.fileEntry.findUnique({ where: { id: req.params.id } });
  if (!file) return res.status(404).json({ error: "File not found" });

  const link = await assertCanAccessDevice(req.user!.userId, file.deviceId);
  if (!link || !isPathAllowed(file.path, link)) return res.status(404).json({ error: "File not accessible for this client" });

  const isOnline = deviceHub.isOnline(file.deviceId);

  if (!isOnline) {
    return res.status(503).json({
      error: "The Android node is offline and file sharing is stopped",
      code: "DEVICE_OFFLINE_SHARING_STOPPED",
      deviceOnline: false,
    });
  }

  const useChunked = req.query.stream === "chunked";

  if (useChunked) {
    // ── Chunked streaming mode ──
    // Each chunk is independently AES-GCM encrypted by the Android device.
    // Response format: [4-byte big-endian chunk length][encrypted chunk bytes]...
    //                  [0x00000000] (end marker)
    const CHUNK_SIZE = 1024 * 1024; // 1 MB plaintext per chunk
    const totalSize = file.sizeBytes;
    const totalChunks = Math.ceil(totalSize / CHUNK_SIZE);
    let firstChunk = 0;
    let lastChunk = Math.max(0, totalChunks - 1);

    const rangeHeader = req.headers.range;
    if (typeof rangeHeader === "string") {
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
      if (!match || (!match[1] && !match[2])) {
        return res.status(416).setHeader("Content-Range", `bytes */${totalSize}`).json({ error: "Invalid byte range" });
      }
      const requestedStart = match[1] ? Number(match[1]) : Math.max(0, totalSize - Number(match[2]));
      const requestedEnd = match[2] ? Number(match[2]) : totalSize - 1;
      if (!Number.isSafeInteger(requestedStart) || !Number.isSafeInteger(requestedEnd) ||
          requestedStart < 0 || requestedStart >= totalSize || requestedStart > requestedEnd) {
        return res.status(416).setHeader("Content-Range", `bytes */${totalSize}`).json({ error: "Requested range is not satisfiable" });
      }
      const end = Math.min(requestedEnd, totalSize - 1);
      firstChunk = Math.floor(requestedStart / CHUNK_SIZE);
      lastChunk = Math.floor(end / CHUNK_SIZE);
      res.status(206);
      // AES-GCM authenticates complete chunks. The response therefore contains
      // complete encrypted chunks covering the requested range, not a partial
      // ciphertext fragment. The web client slices plaintext after decrypting.
      res.setHeader("X-Stashly-Range-Start", String(requestedStart));
      res.setHeader("X-Stashly-Range-End", String(end));
    }

    res.setHeader("Content-Type", "application/x-stashly-chunked");
    res.setHeader("X-Encrypted-Dek", file.encryptedDek);
    res.setHeader("X-Chunk-Size", String(CHUNK_SIZE));
    res.setHeader("X-Total-Chunks", String(totalChunks));
    res.setHeader("X-Total-Plaintext-Size", String(totalSize));
    res.setHeader("X-Chunk-First", String(firstChunk));
    res.setHeader("X-Chunk-Last", String(lastChunk));
    res.setHeader("Transfer-Encoding", "chunked");

    // Stop requesting chunks from Android if the browser disconnects.
    const abortController = new AbortController();
    let finished = false;
    res.on("close", () => {
      if (!finished) abortController.abort();
    });

    const writeWithBackpressure = async (data: Buffer) => {
      if (!res.write(data)) {
        await new Promise<void>((resolve) => res.once("drain", resolve));
      }
    };

    try {
      for (let i = firstChunk; i <= lastChunk; i++) {
        if (abortController.signal.aborted) throw new Error("REQUEST_CANCELLED");

        const offset = i * CHUNK_SIZE;
        const length = Math.min(CHUNK_SIZE, totalSize - offset);
        const encryptedChunk = await deviceHub.requestChunk(
          file.deviceId,
          file.path,
          offset,
          length,
          abortController.signal,
        );

        if (abortController.signal.aborted) throw new Error("REQUEST_CANCELLED");

        // Write 4-byte big-endian length prefix + encrypted chunk
        const lengthBuf = Buffer.alloc(4);
        lengthBuf.writeUInt32BE(encryptedChunk.length, 0);
        await writeWithBackpressure(lengthBuf);
        await writeWithBackpressure(encryptedChunk);
      }

      if (abortController.signal.aborted) throw new Error("REQUEST_CANCELLED");
      // End marker
      await writeWithBackpressure(Buffer.alloc(4, 0));
      finished = true;
      res.end();
    } catch (err: any) {
      if (err?.message === "REQUEST_CANCELLED" || abortController.signal.aborted) {
        if (!res.writableEnded) res.destroy();
        return;
      }
      // If we've already started writing, we can't send a JSON error
      if (res.headersSent) {
        res.end();
        return;
      }
      const offline = err?.message === "DEVICE_OFFLINE" || err?.message === "DEVICE_TIMEOUT";
      return res.status(offline ? 503 : 504).json({
        error: offline ? "The Android node is offline" : (err?.message ?? "Chunk transfer failed"),
        code: offline ? "DEVICE_OFFLINE" : "DEVICE_TIMEOUT",
      });
    }
  } else {
    // ── Legacy full-file mode ──
    try {
      const ciphertext = await deviceHub.requestFile(file.deviceId, file.path);

      // Save to local filesystem storage cache for faster repeated access
      const cacheFilename = `${file.id}.bin`;
      const cacheFilePath = path.join(config.storageDir, cacheFilename);
      try {
        await fs.promises.writeFile(cacheFilePath, ciphertext);
        await prisma.fileEntry.update({
          where: { id: file.id },
          data: {
            lastAccessAt: new Date(),
            isCached: true,
            cacheKey: cacheFilename,
            cachedAt: new Date(),
          },
        });
      } catch (cacheErr) {
        console.warn("Failed to write to local storage cache:", cacheErr);
      }

      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("X-Encrypted-Dek", file.encryptedDek);
      return res.send(ciphertext);
    } catch (err: any) {
      if (err.message !== "DEVICE_TIMEOUT" && err.message !== "DEVICE_OFFLINE") {
        throw err;
      }
      return res.status(503).json({
        error: "The Android node did not respond and file sharing is stopped",
        code: "DEVICE_TIMEOUT_NO_CACHE",
        deviceOnline: false,
      });
    }
  }
});

filesRouter.post("/upload", requireAuth, async (req: AuthedRequest, res) => {
  const { deviceId, path: directory, name, mimeType, dataBase64, encryptedDek } = req.body ?? {};
  if (
    typeof deviceId !== "string" ||
    typeof directory !== "string" ||
    typeof name !== "string" ||
    typeof dataBase64 !== "string" ||
    typeof encryptedDek !== "string"
  ) {
    return res.status(400).json({ error: "deviceId, path, name, dataBase64, and encryptedDek are required" });
  }

  const link = await assertCanAccessDevice(req.user!.userId, deviceId);
  if (!link || !link.sharingEnabled || link.scopeMode === "NONE" || link.scopeMode === "CUSTOM_FILE") {
    return res.status(403).json({ error: "This client does not have folder upload permission for this device" });
  }

  const targetPath = normalizeUploadPath(directory, name);
  const allowedDirectory = directory.startsWith("/") ? directory : `/${directory}`;
  if (!targetPath || !isPathAllowed(allowedDirectory || "/", link)) {
    return res.status(403).json({ error: "The upload destination is outside this client's allowed folder" });
  }

  const payload = Buffer.from(dataBase64, "base64");
  if (payload.length === 0) return res.status(400).json({ error: "The selected file is empty" });
  if (payload.length > 40 * 1024 * 1024) return res.status(413).json({ error: "Uploads are limited to 40 MB" });

  try {
    await deviceHub.uploadFile(deviceId, targetPath, dataBase64, encryptedDek);
    return res.status(202).json({ ok: true, path: targetPath, name, mimeType: mimeType ?? null });
  } catch (err: any) {
    const offline = err?.message === "DEVICE_OFFLINE";
    return res.status(offline ? 503 : 504).json({
      error: offline ? "The Android node is offline" : "The Android node did not finish the upload in time",
      code: offline ? "DEVICE_OFFLINE" : "DEVICE_TIMEOUT",
    });
  }
});

filesRouter.delete("/trash/empty", requireAuth, async (req: AuthedRequest, res) => {
  const deviceId = req.query.deviceId as string | undefined;
  const userDevices = await prisma.userDevice.findMany({
    where: { userId: req.user!.userId, ...(deviceId ? { deviceId } : {}) },
    select: { deviceId: true, sharingEnabled: true },
  });
  const deviceIds = userDevices.filter((ud) => ud.sharingEnabled).map((ud) => ud.deviceId);
  if (deviceIds.length === 0) return res.status(204).send();

  const trashedFiles = await prisma.fileEntry.findMany({
    where: { deviceId: { in: deviceIds }, deletedAt: { not: null } },
  });

  for (const file of trashedFiles) {
    if (deviceHub.isOnline(file.deviceId)) {
      await deviceHub.trashOperation(file.deviceId, file.path, "permanent").catch(() => {});
    }
    const cacheName = file.cacheKey ?? `${file.id}.bin`;
    await fs.promises.unlink(path.join(config.storageDir, cacheName)).catch(() => {});
  }

  await prisma.fileEntry.deleteMany({
    where: { id: { in: trashedFiles.map((f) => f.id) } },
  });

  return res.status(204).send();
});

filesRouter.delete("/:id", requireAuth, async (req: AuthedRequest, res) => {
  const file = await prisma.fileEntry.findUnique({ where: { id: req.params.id } });
  if (!file) return res.status(404).json({ error: "File not found" });

  const link = await assertCanAccessDevice(req.user!.userId, file.deviceId);
  if (!link || !link.sharingEnabled || !isPathAllowed(file.path, link)) {
    return res.status(403).json({ error: "You do not have permission to delete this file" });
  }

  const permanent = req.query.permanent === "true";

  try {
    if (permanent) {
      if (deviceHub.isOnline(file.deviceId)) {
        await deviceHub.trashOperation(file.deviceId, file.path, "permanent");
      }
      const cacheName = file.cacheKey ?? `${file.id}.bin`;
      await fs.promises.unlink(path.join(config.storageDir, cacheName)).catch(() => {});
      await prisma.fileEntry.delete({ where: { id: file.id } });
    } else {
      // Soft-delete to Android storage recycle bin (.stashly_trash)
      // Mark the row first. Moving the file makes it disappear from the
      // Android sync scan, which can arrive before the device response.
      await prisma.fileEntry.update({ where: { id: file.id }, data: { deletedAt: new Date() } });
      if (deviceHub.isOnline(file.deviceId)) {
        try {
          await deviceHub.trashOperation(file.deviceId, file.path, "trash");
        } catch (err) {
          await prisma.fileEntry.update({ where: { id: file.id }, data: { deletedAt: null } });
          throw err;
        }
      }
    }
    return res.status(204).send();
  } catch (err: any) {
    const offline = err?.message === "DEVICE_OFFLINE";
    return res.status(offline ? 503 : 504).json({
      error: offline ? "The Android node is offline" : (err?.message || "Failed to delete file from device"),
      code: offline ? "DEVICE_OFFLINE" : "DEVICE_TIMEOUT",
    });
  }
});
