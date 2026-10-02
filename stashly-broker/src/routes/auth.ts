/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

import { Router } from "express";
import { hashPassword, signMfaChallenge, signUserToken, verifyMfaChallenge, verifyPassword } from "../auth";
import { prisma } from "../db";
import { AuthedRequest, requireAuth } from "../middleware";
import { audit, decryptSecret, encryptSecret, generateTotpSecret, verifyTotp } from "../security";

export const authRouter = Router();

authRouter.post("/register", async (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return res.status(409).json({ error: "Account already exists" });
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({ data: { email, passwordHash } });

  const token = signUserToken({ userId: user.id, email: user.email });
  await audit("account.register", user.id, req);
  res.status(201).json({ token });
});

authRouter.post("/login", async (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  if (user.mfaEnabled && user.mfaSecretCiphertext) {
    await audit("account.login_mfa_required", user.id, req);
    return res.json({ mfaRequired: true, challenge: signMfaChallenge({ userId: user.id, email: user.email }) });
  }
  const token = signUserToken({ userId: user.id, email: user.email });
  await audit("account.login", user.id, req);
  res.json({ token });
});

authRouter.post("/login/mfa", async (req, res) => {
  const challenge = typeof req.body?.challenge === "string" ? req.body.challenge : "";
  const code = typeof req.body?.code === "string" ? req.body.code : "";
  try {
    const payload = verifyMfaChallenge(challenge);
    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user?.mfaEnabled || !user.mfaSecretCiphertext || !verifyTotp(decryptSecret(user.mfaSecretCiphertext), code)) {
      await audit("account.login_mfa_failed", payload.userId, req);
      return res.status(401).json({ error: "Invalid verification code" });
    }
    await audit("account.login_mfa_success", user.id, req);
    return res.json({ token: signUserToken({ userId: user.id, email: user.email }) });
  } catch {
    return res.status(401).json({ error: "Invalid or expired MFA challenge" });
  }
});

authRouter.post("/mfa/setup", requireAuth, async (req: AuthedRequest, res) => {
  const secret = generateTotpSecret();
  await prisma.user.update({ where: { id: req.user!.userId }, data: { mfaSecretCiphertext: encryptSecret(secret), mfaEnabled: false } });
  await audit("mfa.setup_started", req.user!.userId, req);
  const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: { email: true } });
  const label = encodeURIComponent(`Stashly:${user?.email ?? "account"}`);
  return res.json({ secret, otpauthUri: `otpauth://totp/${label}?secret=${secret}&issuer=Stashly` });
});

authRouter.post("/mfa/verify", requireAuth, async (req: AuthedRequest, res) => {
  const code = typeof req.body?.code === "string" ? req.body.code : "";
  const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
  if (!user?.mfaSecretCiphertext || !verifyTotp(decryptSecret(user.mfaSecretCiphertext), code)) return res.status(400).json({ error: "Invalid verification code" });
  await prisma.user.update({ where: { id: user.id }, data: { mfaEnabled: true } });
  await audit("mfa.enabled", user.id, req);
  return res.status(204).send();
});

authRouter.delete("/mfa", requireAuth, async (req: AuthedRequest, res) => {
  const code = typeof req.body?.code === "string" ? req.body.code : "";
  const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
  if (!user?.mfaEnabled || !user.mfaSecretCiphertext || !verifyTotp(decryptSecret(user.mfaSecretCiphertext), code)) return res.status(400).json({ error: "Invalid verification code" });
  await prisma.user.update({ where: { id: user.id }, data: { mfaEnabled: false, mfaSecretCiphertext: null } });
  await audit("mfa.disabled", user.id, req);
  return res.status(204).send();
});

authRouter.get("/mfa/status", requireAuth, async (req: AuthedRequest, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: { mfaEnabled: true } });
  return res.json({ enabled: user?.mfaEnabled ?? false });
});

authRouter.post("/password", requireAuth, async (req: AuthedRequest, res) => {
  const currentPassword = typeof req.body?.currentPassword === "string" ? req.body.currentPassword : "";
  const newPassword = typeof req.body?.newPassword === "string" ? req.body.newPassword : "";
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "currentPassword and newPassword are required" });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: "New password must be at least 6 characters" });
  }

  const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
  if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
    return res.status(401).json({ error: "Current password is incorrect" });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(newPassword) },
  });
  await audit("account.password_changed", user.id, req);
  res.status(204).send();
});
