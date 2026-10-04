/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

import crypto from "crypto";
import { config } from "./config";
import { prisma } from "./db";

const MFA_CIPHERTEXT_VERSION = "v1";
const key = crypto.createHash("sha256").update(config.mfaEncryptionKey, "utf8").digest();

export function encryptSecret(value: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${MFA_CIPHERTEXT_VERSION}.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function decryptSecret(value: string): string {
  const [version, ivText, tagText, ciphertextText] = value.split(".");
  if (version !== MFA_CIPHERTEXT_VERSION || !ivText || !tagText || !ciphertextText) {
    throw new Error("Unsupported MFA secret encryption version");
  }
  const iv = Buffer.from(ivText, "base64url");
  const tag = Buffer.from(tagText, "base64url");
  const ciphertext = Buffer.from(ciphertextText, "base64url");
  if (iv.length !== 12 || tag.length !== 16) throw new Error("Invalid MFA secret encryption envelope");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Decode(input: string): Buffer {
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of input.toUpperCase().replace(/=+$/, "").replace(/\s/g, "")) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error("Invalid TOTP secret");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) { output.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(output);
}

export function generateTotpSecret(): string {
  const bytes = crypto.randomBytes(20);
  let output = "";
  for (let i = 0; i < bytes.length; i += 5) {
    let value = 0;
    for (let j = 0; j < 5; j++) value = (value << 8) | (bytes[i + j] ?? 0);
    for (let j = 7; j >= 0; j--) output += alphabet[(value >>> (j * 5)) & 31];
  }
  return output;
}

export function verifyTotp(secret: string, code: string, now = Date.now()): boolean {
  const normalized = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(normalized)) return false;
  const keyBytes = base32Decode(secret);
  const counter = Math.floor(now / 1000 / 30);
  for (const offset of [-1, 0, 1]) {
    const data = Buffer.alloc(8);
    data.writeBigUInt64BE(BigInt(counter + offset));
    const digest = crypto.createHmac("sha1", keyBytes).update(data).digest();
    const start = digest[digest.length - 1] & 15;
    const value = ((digest[start] & 127) << 24) | (digest[start + 1] << 16) | (digest[start + 2] << 8) | digest[start + 3];
    if (crypto.timingSafeEqual(Buffer.from(String(value % 1_000_000).padStart(6, "0")), Buffer.from(normalized))) return true;
  }
  return false;
}

export async function audit(action: string, actorUserId?: string, req?: { ip?: string }, targetType?: string, targetId?: string, metadata?: object) {
  try {
    await prisma.auditLog.create({ data: { action, actorUserId, ipAddress: req?.ip, targetType, targetId, metadata } });
  } catch (error) {
    console.error("Security audit write failed:", error);
  }
}
