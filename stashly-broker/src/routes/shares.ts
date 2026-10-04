/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

import crypto from "crypto";
import { Router } from "express";
import { config } from "../config";
import { prisma } from "../db";
import { AuthedRequest, requireAuth } from "../middleware";
import { deviceHub } from "../ws/deviceHub";
import { isPathAllowed } from "../access";
import { audit } from "../security";

export const sharesRouter = Router();
const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

sharesRouter.post("/", requireAuth, async (req: AuthedRequest, res) => {
  const { fileId, deviceId, scopePath, expiresInSeconds = 86400 } = req.body ?? {};
  if (typeof fileId !== "string" || typeof deviceId !== "string") return res.status(400).json({ error: "fileId and deviceId are required" });
  const seconds = Number(expiresInSeconds);
  if (!Number.isFinite(seconds) || seconds < 60 || seconds > 60 * 60 * 24 * 30) return res.status(400).json({ error: "Expiry must be between 1 minute and 30 days" });
  const link = await prisma.userDevice.findUnique({ where: { userId_deviceId: { userId: req.user!.userId, deviceId } } });
  const file = await prisma.fileEntry.findFirst({ where: { id: fileId, deviceId } });
  if (!link || !file || !link.sharingEnabled || !isPathAllowed(file.path, link)) return res.status(403).json({ error: "File is not accessible" });
  const requestedPath = typeof scopePath === "string" && scopePath.trim() ? scopePath.trim() : file.path;
  if (!isPathAllowed(requestedPath, link)) return res.status(403).json({ error: "Share scope is outside your access" });
  const rawToken = crypto.randomBytes(32).toString("base64url");
  const share = await prisma.shareLink.create({ data: {
    ownerId: req.user!.userId, deviceId, fileId, scopeMode: "CUSTOM_FILE", scopePath: requestedPath,
    tokenHash: hashToken(rawToken), expiresAt: new Date(Date.now() + seconds * 1000),
  } });
  await audit("share.created", req.user!.userId, req, "share", share.id, { deviceId, fileId, expiresAt: share.expiresAt.toISOString() });
  const origin = config.publicUrl ?? `${req.protocol}://${req.get("host")}`;
  return res.status(201).json({ id: share.id, token: rawToken, expiresAt: share.expiresAt, url: `${origin}/share/${rawToken}` });
});

sharesRouter.get("/", requireAuth, async (req: AuthedRequest, res) => {
  const shares = await prisma.shareLink.findMany({ where: { ownerId: req.user!.userId }, orderBy: { createdAt: "desc" }, select: { id: true, deviceId: true, fileId: true, scopePath: true, expiresAt: true, revokedAt: true, createdAt: true, accessCount: true, lastAccessAt: true } });
  return res.json(shares);
});

sharesRouter.delete("/:id", requireAuth, async (req: AuthedRequest, res) => {
  const share = await prisma.shareLink.findFirst({ where: { id: req.params.id, ownerId: req.user!.userId } });
  if (!share) return res.status(404).json({ error: "Share link not found" });
  await prisma.shareLink.update({ where: { id: share.id }, data: { revokedAt: new Date() } });
  await audit("share.revoked", req.user!.userId, req, "share", share.id);
  return res.status(204).send();
});

async function resolve(rawToken: string) {
  const share = await prisma.shareLink.findUnique({ where: { tokenHash: hashToken(rawToken) }, include: { file: true } });
  if (!share || share.revokedAt || share.expiresAt <= new Date() || !share.file || share.scopePath !== share.file.path) return null;
  return share;
}

sharesRouter.get("/:token", async (req, res) => {
  const share = await resolve(req.params.token);
  if (!share) return res.status(404).json({ error: "Share link is invalid, expired, or revoked" });
  await prisma.shareLink.update({ where: { id: share.id }, data: { lastAccessAt: new Date(), accessCount: { increment: 1 } } });
  res.json({ id: share.id, file: { id: share.file!.id, name: share.file!.name, path: share.file!.path, sizeBytes: share.file!.sizeBytes, mimeType: share.file!.mimeType }, expiresAt: share.expiresAt });
});

sharesRouter.get("/:token/download", async (req, res) => {
  const share = await resolve(req.params.token);
  if (!share) return res.status(404).json({ error: "Share link is invalid, expired, or revoked" });
  const file = share.file!;
  if (!deviceHub.isOnline(file.deviceId)) return res.status(503).json({ error: "The storage node is offline", code: "DEVICE_OFFLINE" });
  try {
    const ciphertext = await deviceHub.requestFile(file.deviceId, file.path);
    await prisma.shareLink.update({ where: { id: share.id }, data: { lastAccessAt: new Date(), accessCount: { increment: 1 } } });
    res.setHeader("Content-Type", "application/octet-stream");
    return res.send(ciphertext);
  } catch {
    return res.status(503).json({ error: "The storage node did not respond", code: "DEVICE_TIMEOUT" });
  }
});
