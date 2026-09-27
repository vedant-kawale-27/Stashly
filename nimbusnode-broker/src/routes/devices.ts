import { Router } from "express";
import { generatePairingToken, signDeviceToken } from "../auth";
import { config } from "../config";
import { prisma } from "../db";
import { AuthedRequest, requireAuth } from "../middleware";
import { deviceHub } from "../ws/deviceHub";

export const devicesRouter = Router();

// --- Step 1: signed-in user requests a pairing code, shows it as a QR code ---
devicesRouter.post("/pairing-tokens", requireAuth, async (req: AuthedRequest, res) => {
  const token = generatePairingToken();
  const expiresAt = new Date(Date.now() + config.pairingTokenTtlSeconds * 1000);

  await prisma.pairingToken.create({
    data: { userId: req.user!.userId, token, expiresAt },
  });

  res.status(201).json({ token, expiresAt });
});

// --- Step 2: phone app scans/enters the code, exchanges it for a device token ---
// No user auth required here — the pairing token itself is the credential,
// exactly like a Wi-Fi QR code or a Google TV pairing flow.
devicesRouter.post("/pair", async (req, res) => {
  const { token, deviceName, storageQuotaMb } = req.body ?? {};
  if (!token || !deviceName) {
    return res.status(400).json({ error: "token and deviceName are required" });
  }

  const pairing = await prisma.pairingToken.findUnique({ where: { token } });
  if (!pairing || pairing.used || pairing.expiresAt < new Date()) {
    return res.status(400).json({ error: "Pairing token is invalid or expired" });
  }

  const device = await prisma.device.create({
    data: {
      userId: pairing.userId,
      name: deviceName,
      storageQuotaMb: storageQuotaMb ?? 0,
    },
  });

  await prisma.pairingToken.update({
    where: { token },
    data: { used: true },
  });

  const deviceToken = signDeviceToken({ deviceId: device.id, userId: pairing.userId });
  res.status(201).json({ deviceId: device.id, deviceToken });
});

// --- List the signed-in user's paired devices, with live online status ---
devicesRouter.get("/", requireAuth, async (req: AuthedRequest, res) => {
  const devices = await prisma.device.findMany({
    where: { userId: req.user!.userId },
    orderBy: { createdAt: "asc" },
  });

  res.json(
    devices.map((d: { id: string }) => ({
      ...d,
      status: deviceHub.isOnline(d.id) ? "online" : "offline",
    }))
  );
});

devicesRouter.delete("/:id", requireAuth, async (req: AuthedRequest, res) => {
  const device = await prisma.device.findUnique({ where: { id: req.params.id } });
  if (!device || device.userId !== req.user!.userId) {
    return res.status(404).json({ error: "Device not found" });
  }
  await prisma.fileEntry.deleteMany({ where: { deviceId: device.id } });
  await prisma.device.delete({ where: { id: device.id } });
  res.status(204).send();
});
