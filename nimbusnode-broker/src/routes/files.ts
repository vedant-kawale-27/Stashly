import { Router } from "express";
import { prisma } from "../db";
import { AuthedRequest, requireAuth } from "../middleware";
import { deviceHub } from "../ws/deviceHub";

export const filesRouter = Router();

async function assertOwnsDevice(userId: string, deviceId: string) {
  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device || device.userId !== userId) return null;
  return device;
}

// GET /files?deviceId=... — list metadata (never file content) for the user's device(s).
filesRouter.get("/", requireAuth, async (req: AuthedRequest, res) => {
  const deviceId = req.query.deviceId as string | undefined;

  const devices = await prisma.device.findMany({
    where: { userId: req.user!.userId, ...(deviceId ? { id: deviceId } : {}) },
    select: { id: true },
  });
  const deviceIds = devices.map((d: { id: string }) => d.id);

  const files = await prisma.fileEntry.findMany({
    where: { deviceId: { in: deviceIds } },
    orderBy: { path: "asc" },
  });

  res.json(
    files.map((f: { deviceId: string }) => ({
      ...f,
      deviceOnline: deviceHub.isOnline(f.deviceId),
    }))
  );
});

// GET /files/:id/download — fetch ciphertext, either live from the phone or
// from the broker's cache (cache storage integration is a TODO stub below).
filesRouter.get("/:id/download", requireAuth, async (req: AuthedRequest, res) => {
  const file = await prisma.fileEntry.findUnique({ where: { id: req.params.id } });
  if (!file) return res.status(404).json({ error: "File not found" });

  const device = await assertOwnsDevice(req.user!.userId, file.deviceId);
  if (!device) return res.status(404).json({ error: "File not found" });

  if (deviceHub.isOnline(file.deviceId)) {
    try {
      const ciphertext = await deviceHub.requestFile(file.deviceId, file.path);
      await prisma.fileEntry.update({
        where: { id: file.id },
        data: { lastAccessAt: new Date() },
      });
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("X-Encrypted-Dek", file.encryptedDek);
      return res.send(ciphertext);
    } catch (err: any) {
      if (err.message !== "DEVICE_TIMEOUT") throw err;
      // fall through to cache check below
    }
  }

  if (file.isCached && file.cacheKey) {
    // TODO: fetch `file.cacheKey` from blob storage (S3/MinIO) and stream it.
    // Left unimplemented in this skeleton — wire up your storage client here.
    return res.status(501).json({ error: "Cache retrieval not yet implemented" });
  }

  return res.status(503).json({
    error: "Device is offline and no cached copy is available",
    code: "DEVICE_OFFLINE_NO_CACHE",
  });
});
