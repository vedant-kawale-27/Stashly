import { Router } from "express";
import fs from "fs";
import path from "path";
import { config } from "../config";
import { prisma } from "../db";
import { AuthedRequest, requireAuth } from "../middleware";
import { deviceHub } from "../ws/deviceHub";
import { isPathAllowed } from "../access";

export const filesRouter = Router();

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

  const userDevices = await prisma.userDevice.findMany({
    where: { userId: req.user!.userId, ...(deviceId ? { deviceId } : {}) },
    select: { deviceId: true, scopeMode: true, scopePath: true, sharingEnabled: true },
  });
  const deviceIds = userDevices.map((ud) => ud.deviceId);

  if (deviceIds.length === 0) {
    return res.json([]);
  }

  const files = await prisma.fileEntry.findMany({
    where: { deviceId: { in: deviceIds } },
    orderBy: { path: "asc" },
  });

  const linksByDevice = new Map(userDevices.map((link) => [link.deviceId, link]));
  res.json(
    files.filter((f) => {
      const link = linksByDevice.get(f.deviceId);
      return link ? isPathAllowed(f.path, link) : false;
    }).map((f) => ({
      ...f,
      deviceOnline: deviceHub.isOnline(f.deviceId),
    }))
  );
});

// GET /files/:id/download — fetch ciphertext, either live from the phone or
// from the local filesystem storage cache.
filesRouter.get("/:id/download", requireAuth, async (req: AuthedRequest, res) => {
  const file = await prisma.fileEntry.findUnique({ where: { id: req.params.id } });
  if (!file) return res.status(404).json({ error: "File not found" });

  const link = await assertCanAccessDevice(req.user!.userId, file.deviceId);
  if (!link || !isPathAllowed(file.path, link)) return res.status(404).json({ error: "File not accessible for this client" });

  const isOnline = deviceHub.isOnline(file.deviceId);

  if (isOnline) {
    try {
      const ciphertext = await deviceHub.requestFile(file.deviceId, file.path);
      
      // Save to local filesystem storage cache for offline access
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
      // fall through to local storage cache check below
    }
  }

  // Fallback: check local filesystem cache if phone is offline
  if (file.isCached && file.cacheKey) {
    const cacheFilePath = path.join(config.storageDir, file.cacheKey);
    if (fs.existsSync(cacheFilePath)) {
      try {
        const cachedData = await fs.promises.readFile(cacheFilePath);
        await prisma.fileEntry.update({
          where: { id: file.id },
          data: { lastAccessAt: new Date() },
        });
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("X-Encrypted-Dek", file.encryptedDek);
        res.setHeader("X-From-Local-Cache", "true");
        return res.send(cachedData);
      } catch (readErr) {
        console.warn("Failed to read from local storage cache:", readErr);
      }
    }
  }

  return res.status(503).json({
    error: isOnline
      ? "The Android node did not respond in time and no cached copy is available"
      : "The Android node is not connected to this broker and no cached copy is available",
    code: isOnline ? "DEVICE_TIMEOUT_NO_CACHE" : "DEVICE_OFFLINE_NO_CACHE",
    deviceOnline: isOnline,
  });
});
