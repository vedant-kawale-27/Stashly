import { Router } from "express";
import { generatePairingToken, signDeviceToken, verifyDeviceToken } from "../auth";
import { config } from "../config";
import { prisma } from "../db";
import { AuthedRequest, requireAuth } from "../middleware";
import { deviceHub } from "../ws/deviceHub";

export const devicesRouter = Router();

// --- Step 1: signed-in user requests a pairing code (6-char code / QR token) ---
devicesRouter.post("/pairing-tokens", requireAuth, async (req: AuthedRequest, res) => {
  const token = generatePairingToken();
  const expiresAt = new Date(Date.now() + config.pairingTokenTtlSeconds * 1000);

  await prisma.pairingToken.create({
    data: { userId: req.user!.userId, token, expiresAt },
  });

  res.status(201).json({ token, expiresAt });
});

// --- Step 2: phone app scans/enters the code, exchanges it for a device token ---
devicesRouter.post("/pair", async (req, res) => {
  const {
    token,
    deviceName,
    deviceId: existingDeviceId,
    storageQuotaMb,
    platform = "android",
    osVersion,
    appVersion,
  } = req.body ?? {};

  if (!token || (!deviceName && !existingDeviceId)) {
    return res.status(400).json({ error: "token and deviceName are required" });
  }

  const normalizedToken = String(token).trim().toUpperCase();

  const pairing = await prisma.pairingToken.findUnique({
    where: { token: normalizedToken },
    include: { user: { select: { email: true } } },
  });

  if (!pairing || pairing.used || pairing.expiresAt < new Date()) {
    return res.status(400).json({ error: "Pairing token is invalid or expired" });
  }

  let device;
  if (existingDeviceId) {
    device = await prisma.device.findUnique({ where: { id: existingDeviceId } });
  }

  if (device) {
    device = await prisma.device.update({
      where: { id: device.id },
      data: {
        ...(deviceName ? { name: deviceName } : {}),
        platform: platform || device.platform,
        osVersion: osVersion ?? device.osVersion,
        appVersion: appVersion ?? device.appVersion,
        storageQuotaMb: storageQuotaMb ?? device.storageQuotaMb,
      },
    });

    await prisma.userDevice.upsert({
      where: { userId_deviceId: { userId: pairing.userId, deviceId: device.id } },
      create: {
        userId: pairing.userId,
        deviceId: device.id,
        role: "viewer",
      },
      update: {},
    });
  } else {
    device = await prisma.device.create({
      data: {
        name: deviceName,
        platform: platform || "android",
        osVersion: osVersion || null,
        appVersion: appVersion || null,
        storageQuotaMb: storageQuotaMb ?? 0,
      },
    });

    await prisma.userDevice.create({
      data: {
        userId: pairing.userId,
        deviceId: device.id,
        role: "owner",
      },
    });
  }

  await prisma.pairingToken.update({
    where: { token },
    data: { used: true },
  });

  const deviceToken = signDeviceToken({ deviceId: device.id, userId: pairing.userId });
  res.status(201).json({
    deviceId: device.id,
    deviceToken,
    name: device.name,
    userEmail: pairing.user.email,
  });
});

// --- Node self-status query for the Android client ---
devicesRouter.get("/self", async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid token" });
  }
  const token = auth.slice(7);
  try {
    const payload = verifyDeviceToken(token);
    const device = await prisma.device.findUnique({
      where: { id: payload.deviceId },
      include: {
        userDevices: {
          include: {
            user: { select: { email: true } },
          },
        },
      },
    });
    if (!device) return res.status(404).json({ error: "Device not found" });

    const isLive = deviceHub.isOnline(device.id);
    const users = device.userDevices.map((ud) => ({
      email: ud.user.email,
      role: ud.role,
    }));

    res.json({
      id: device.id,
      name: device.name,
      isLive,
      lastSeenAt: device.lastSeenAt,
      users,
    });
  } catch {
    return res.status(401).json({ error: "Invalid device token" });
  }
});

// --- List devices accessible to the signed-in user with live status and sharing info ---
devicesRouter.get("/", requireAuth, async (req: AuthedRequest, res) => {
  const userDevices = await prisma.userDevice.findMany({
    where: { userId: req.user!.userId },
    include: {
      device: {
        include: {
          userDevices: {
            include: {
              user: {
                select: { id: true, email: true },
              },
            },
          },
          _count: {
            select: { files: true },
          },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const deviceSummaries = userDevices.map((ud) => {
    const d = ud.device;
    const isOnline = deviceHub.isOnline(d.id);
    const sharedUsers = d.userDevices.map((link) => ({
      userId: link.user.id,
      email: link.user.email,
      role: link.role,
      since: link.createdAt,
    }));

    return {
      id: d.id,
      name: d.name,
      platform: d.platform,
      osVersion: d.osVersion,
      appVersion: d.appVersion,
      status: isOnline ? "online" : "offline",
      lastSeenAt: d.lastSeenAt,
      storageQuotaMb: d.storageQuotaMb,
      createdAt: d.createdAt,
      fileCount: d._count.files,
      role: ud.role,
      sharedWith: sharedUsers,
    };
  });

  res.json(deviceSummaries);
});

// --- Rename device ---
devicesRouter.patch("/:id", requireAuth, async (req: AuthedRequest, res) => {
  const { name } = req.body ?? {};
  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "name is required" });
  }

  const link = await prisma.userDevice.findUnique({
    where: { userId_deviceId: { userId: req.user!.userId, deviceId: req.params.id } },
  });
  if (!link) {
    return res.status(404).json({ error: "Device not found or not accessible" });
  }

  const updated = await prisma.device.update({
    where: { id: req.params.id },
    data: { name: name.trim() },
  });

  res.json({ id: updated.id, name: updated.name });
});

// --- Delete or unlink device ---
devicesRouter.delete("/:id", requireAuth, async (req: AuthedRequest, res) => {
  const link = await prisma.userDevice.findUnique({
    where: { userId_deviceId: { userId: req.user!.userId, deviceId: req.params.id } },
  });
  if (!link) {
    return res.status(404).json({ error: "Device not found" });
  }

  const totalLinks = await prisma.userDevice.count({
    where: { deviceId: req.params.id },
  });

  if (link.role === "owner" && totalLinks <= 1) {
    await prisma.fileEntry.deleteMany({ where: { deviceId: req.params.id } });
    await prisma.device.delete({ where: { id: req.params.id } });
  } else {
    await prisma.userDevice.delete({
      where: { userId_deviceId: { userId: req.user!.userId, deviceId: req.params.id } },
    });
  }

  res.status(204).send();
});
