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
import { generatePairingToken, signDeviceToken, verifyDeviceToken } from "../auth";
import { config } from "../config";
import { prisma } from "../db";
import { AuthedRequest, requireAuth } from "../middleware";
import { deviceHub } from "../ws/deviceHub";
import { isDirectoryEntry, isPathAllowed } from "../access";

export const devicesRouter = Router();

devicesRouter.post("/:deviceId/sync", requireAuth, async (req: AuthedRequest, res) => {
  const link = await prisma.userDevice.findUnique({
    where: { userId_deviceId: { userId: req.user!.userId, deviceId: req.params.deviceId } },
  });
  if (!link) return res.status(404).json({ error: "Device not found" });

  try {
    await deviceHub.requestSync(req.params.deviceId);
    return res.status(204).send();
  } catch (error: any) {
    const offline = error?.message === "DEVICE_OFFLINE";
    return res.status(offline ? 503 : 504).json({
      error: offline ? "The Android node is offline" : "The Android node did not finish syncing in time",
      code: offline ? "DEVICE_OFFLINE" : "DEVICE_TIMEOUT",
    });
  }
});

devicesRouter.post("/presence", requireAuth, async (req: AuthedRequest, res) => {
  const links = await prisma.userDevice.findMany({
    where: { userId: req.user!.userId },
    select: { deviceId: true },
  });
  links.forEach(({ deviceId }) => deviceHub.setClientPresence(deviceId, req.user!.userId, true));
  res.status(204).send();
});

devicesRouter.delete("/presence", requireAuth, async (req: AuthedRequest, res) => {
  const links = await prisma.userDevice.findMany({
    where: { userId: req.user!.userId },
    select: { deviceId: true },
  });
  links.forEach(({ deviceId }) => deviceHub.setClientPresence(deviceId, req.user!.userId, false));
  res.status(204).send();
});

devicesRouter.delete("/self/reset", async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return res.status(401).json({ error: "Missing or invalid token" });

  try {
    const payload = verifyDeviceToken(auth.slice(7));
    const device = await prisma.device.findUnique({
      where: { id: payload.deviceId },
      include: { files: { select: { id: true } } },
    });
    if (!device) return res.status(404).json({ error: "Device not found" });

    deviceHub.notifyDeviceRemoved(payload.deviceId, "Node credentials were reset");
    await Promise.all(device.files.map((file) =>
      fs.promises.unlink(path.join(config.storageDir, `${file.id}.bin`)).catch(() => {})
    ));
    await prisma.fileEntry.deleteMany({ where: { deviceId: payload.deviceId } });
    await prisma.device.delete({ where: { id: payload.deviceId } });
    return res.status(204).send();
  } catch (error: any) {
    if (error?.name === "JsonWebTokenError" || error?.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Invalid device token" });
    }
    console.error("Failed to reset node credentials:", error);
    return res.status(500).json({ error: "Could not reset node credentials" });
  }
});

function normalizeScope(body: any) {
  const scopeMode = body?.scopeMode === "NONE" || body?.scopeMode === "CUSTOM_FOLDER" || body?.scopeMode === "CUSTOM_FILE"
    ? body.scopeMode
    : "ALL";
  const scopePath = typeof body?.scopePath === "string" ? body.scopePath.trim() : null;
  const scopeName = typeof body?.scopeName === "string" ? body.scopeName.trim() : null;

  if ((scopeMode === "CUSTOM_FOLDER" || scopeMode === "CUSTOM_FILE") && !scopePath) {
    return { error: "scopePath is required for a file or folder scope" };
  }

  return {
    scopeMode,
    scopePath: scopeMode !== "ALL" ? scopePath : null,
    scopeName: scopeMode !== "ALL" ? (scopeName || scopePath) : null,
  };
}

// --- Step 1: signed-in user requests a pairing code (6-char code / QR token) ---
devicesRouter.post("/pairing-tokens", requireAuth, async (req: AuthedRequest, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.userId },
    select: { id: true },
  });
  if (!user) {
    return res.status(401).json({ error: "Your session is no longer valid. Please sign in again." });
  }

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
    modelName,
    modelNumber,
    androidVersion,
    osVersion,
    appVersion,
    batteryLevel,
    storageTotalMb,
    storageFreeMb,
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

  // Device health and identity are session data. Seed the in-memory snapshot
  // from pairing so the Devices page does not wait for the first WS heartbeat.
  deviceHub.updateDeviceTelemetry(device.id, {
    ...(typeof modelName === "string" ? { modelName } : {}),
    ...(typeof modelNumber === "string" ? { modelNumber } : {}),
    ...(typeof androidVersion === "string" ? { androidVersion } : {}),
    ...(typeof osVersion === "string" ? { osVersion } : {}),
    ...(typeof appVersion === "string" ? { appVersion } : {}),
    ...(Number.isInteger(batteryLevel) ? { batteryLevel } : {}),
    ...(Number.isInteger(storageTotalMb) ? { storageTotalMb } : {}),
    ...(Number.isInteger(storageFreeMb) ? { storageFreeMb } : {}),
  });

  await prisma.pairingToken.update({
    where: { token },
    data: { used: true },
  });

  const userLink = await prisma.userDevice.findUnique({
    where: { userId_deviceId: { userId: pairing.userId, deviceId: device.id } },
    select: { role: true },
  });

  const deviceToken = signDeviceToken({ deviceId: device.id, userId: pairing.userId });
  res.status(201).json({
    deviceId: device.id,
    deviceToken,
    name: device.name,
    userId: pairing.userId,
    role: userLink?.role ?? "viewer",
    userEmail: pairing.user.email,
  });
});

// --- Read or update the scope for the client represented by a device token ---
devicesRouter.get("/self/scope", async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return res.status(401).json({ error: "Missing or invalid token" });

  try {
    const payload = verifyDeviceToken(auth.slice(7));
    const link = await prisma.userDevice.findUnique({
      where: { userId_deviceId: { userId: payload.userId, deviceId: payload.deviceId } },
      select: { scopeMode: true, scopePath: true, scopeName: true, sharingEnabled: true },
    });
    if (!link) return res.status(404).json({ error: "Device access link not found" });
    return res.json(link);
  } catch {
    return res.status(401).json({ error: "Invalid device token" });
  }
});

devicesRouter.put("/self/scope", async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return res.status(401).json({ error: "Missing or invalid token" });

  const scope = normalizeScope(req.body);
  if ("error" in scope) return res.status(400).json(scope);

  try {
    const payload = verifyDeviceToken(auth.slice(7));
    const targetUserId = typeof req.body?.targetUserId === "string" && req.body.targetUserId.trim()
      ? req.body.targetUserId.trim()
      : payload.userId;
    const link = await prisma.userDevice.update({
      where: { userId_deviceId: { userId: targetUserId, deviceId: payload.deviceId } },
      data: { ...scope, sharingEnabled: true },
      select: { scopeMode: true, scopePath: true, scopeName: true, sharingEnabled: true },
    });
    return res.json(link);
  } catch (error: any) {
    if (error?.code === "P2025") return res.status(404).json({ error: "Device access link not found" });
    if (error?.name === "JsonWebTokenError" || error?.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Invalid device token" });
    }
    console.error("Failed to update client access scope:", error);
    return res.status(500).json({ error: "Could not update client access" });
  }
});

devicesRouter.put("/self/client/:targetUserId/sharing", async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return res.status(401).json({ error: "Missing or invalid token" });
  if (typeof req.body?.enabled !== "boolean") return res.status(400).json({ error: "enabled must be boolean" });

  try {
    const payload = verifyDeviceToken(auth.slice(7));
    const link = await prisma.userDevice.update({
      where: { userId_deviceId: { userId: req.params.targetUserId, deviceId: payload.deviceId } },
      data: { sharingEnabled: req.body.enabled },
      select: { scopeMode: true, scopePath: true, scopeName: true, sharingEnabled: true },
    });
    deviceHub.notifyClientPresence(payload.deviceId, req.params.targetUserId, req.body.enabled);
    return res.json(link);
  } catch (error: any) {
    if (error?.code === "P2025") return res.status(404).json({ error: "Client access link not found" });
    if (error?.name === "JsonWebTokenError" || error?.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Invalid device token" });
    }
    console.error("Failed to update client sharing state:", error);
    return res.status(500).json({ error: "Could not update client sharing" });
  }
});

devicesRouter.delete("/self/client/:targetUserId", async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return res.status(401).json({ error: "Missing or invalid token" });

  try {
    const payload = verifyDeviceToken(auth.slice(7));
    const targetUserId = req.params.targetUserId;
    const target = await prisma.userDevice.findUnique({
      where: { userId_deviceId: { userId: targetUserId, deviceId: payload.deviceId } },
    });
    if (!target) return res.status(404).json({ error: "Client access link not found" });

    await prisma.userDevice.delete({
      where: { userId_deviceId: { userId: targetUserId, deviceId: payload.deviceId } },
    });
    const remaining = await prisma.userDevice.count({ where: { deviceId: payload.deviceId } });
    deviceHub.notifyClientRemoved(payload.deviceId, targetUserId);
    if (remaining === 0) {
      deviceHub.notifyDeviceRemoved(payload.deviceId, "All client connections were removed from this node");
      await prisma.fileEntry.deleteMany({ where: { deviceId: payload.deviceId } });
      await prisma.device.delete({ where: { id: payload.deviceId } }).catch(() => {});
    }
    return res.status(204).send();
  } catch (error: any) {
    if (error?.code === "P2025") return res.status(404).json({ error: "Client access link not found" });
    return res.status(401).json({ error: "Invalid device token" });
  }
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
      userId: ud.userId,
      email: ud.user.email,
      role: ud.role,
      scopeMode: ud.scopeMode,
      scopePath: ud.scopePath,
      scopeName: ud.scopeName,
      sharingEnabled: ud.sharingEnabled,
      isLive: ud.sharingEnabled && deviceHub.isClientOnline(device.id, ud.userId),
      lastSeenAt: deviceHub.clientLastSeenAt(device.id, ud.userId),
      connectedAt: ud.createdAt,
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
          files: {
            select: { path: true, mimeType: true, contentHash: true },
          },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const deviceSummaries = userDevices.map((ud) => {
    const d = ud.device;
    const isOnline = deviceHub.isOnline(d.id);
    const liveInfo = deviceHub.getDeviceTelemetry(d.id);
    const accessibleFileCount = d.files.filter((file) =>
      !isDirectoryEntry(file) && isPathAllowed(file.path, ud)
    ).length;
    const sharedUsers = d.userDevices.map((link) => ({
      userId: link.user.id,
      email: link.user.email,
      role: link.role,
      scopeMode: link.scopeMode,
      scopePath: link.scopePath,
      scopeName: link.scopeName,
      sharingEnabled: link.sharingEnabled,
      isLive: link.sharingEnabled && deviceHub.isClientOnline(d.id, link.user.id),
      lastSeenAt: deviceHub.clientLastSeenAt(d.id, link.user.id),
      connectedAt: link.createdAt,
      since: link.createdAt,
    }));

    return {
      id: d.id,
      name: d.name,
      platform: d.platform,
      ...liveInfo,
      status: isOnline ? "online" : "offline",
      lastSeenAt: d.lastSeenAt,
      storageQuotaMb: d.storageQuotaMb,
      createdAt: d.createdAt,
      fileCount: accessibleFileCount,
      role: ud.role,
      sharingEnabled: ud.sharingEnabled,
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
    deviceHub.notifyClientRemoved(req.params.id, req.user!.userId);
    deviceHub.notifyDeviceRemoved(req.params.id, "Node was removed from the Stashly Web Dashboard");
    await prisma.fileEntry.deleteMany({ where: { deviceId: req.params.id } });
    await prisma.device.delete({ where: { id: req.params.id } });
  } else {
    await prisma.userDevice.delete({
      where: { userId_deviceId: { userId: req.user!.userId, deviceId: req.params.id } },
    });
    const remaining = await prisma.userDevice.count({ where: { deviceId: req.params.id } });
    if (remaining === 0) {
      deviceHub.notifyClientRemoved(req.params.id, req.user!.userId);
      deviceHub.notifyDeviceRemoved(req.params.id, "Node was removed from the Stashly Web Dashboard");
      await prisma.fileEntry.deleteMany({ where: { deviceId: req.params.id } });
      await prisma.device.delete({ where: { id: req.params.id } }).catch(() => {});
    } else {
      deviceHub.notifyClientRemoved(req.params.id, req.user!.userId);
    }
  }

  res.status(204).send();
});
