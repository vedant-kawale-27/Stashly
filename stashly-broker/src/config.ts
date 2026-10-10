/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

import "dotenv/config";
import path from "path";
import fs from "fs";
import crypto from "crypto";

const nodeEnv = (process.env.NODE_ENV ?? "development").toLowerCase();
const isProduction = nodeEnv === "production";

let databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  if (isProduction) {
    throw new Error("DATABASE_URL is required in production and must be a PostgreSQL connection URL (postgresql://...)");
  } else {
    databaseUrl = "file:./dev.db";
    process.env.DATABASE_URL = databaseUrl;
  }
}

if (isProduction) {
  if (!databaseUrl.startsWith("postgresql://") && !databaseUrl.startsWith("postgres://")) {
    throw new Error(`In production (NODE_ENV=production), DATABASE_URL must be a PostgreSQL URL (postgresql://...). Received: "${databaseUrl}"`);
  }
} else {
  if (
    !databaseUrl.startsWith("file:") &&
    !databaseUrl.startsWith("postgresql://") &&
    !databaseUrl.startsWith("postgres://")
  ) {
    throw new Error(`In development, DATABASE_URL must be a SQLite file URL (file:./dev.db) or PostgreSQL URL. Received: "${databaseUrl}"`);
  }
}

const databaseProvider = isProduction ? "postgresql" : (databaseUrl.startsWith("file:") ? "sqlite" : "postgresql");

function required(name: string): string {
  const val = process.env[name];
  if (val === undefined) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return val;
}

const storageDir = process.env.STORAGE_DIR || path.resolve(process.cwd(), "storage", "cache");
if (!fs.existsSync(storageDir)) {
  try {
    fs.mkdirSync(storageDir, { recursive: true });
  } catch {
    // ignore if already exists or permission issues
  }
}

const jwtSecret = required("JWT_SECRET");
if (jwtSecret.length < 32) {
  throw new Error("JWT_SECRET must be at least 32 characters long");
}

const mfaEncryptionKey = process.env.MFA_ENCRYPTION_KEY?.trim();
if (!mfaEncryptionKey) {
  const generated = crypto.randomBytes(32).toString("base64url");
  throw new Error(`MFA_ENCRYPTION_KEY is required. Persist this generated value before starting the broker: ${generated}`);
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  nodeEnv,
  isProduction,
  databaseUrl,
  databaseProvider,
  publicUrl: process.env.PUBLIC_URL ? process.env.PUBLIC_URL.trim().replace(/\/+$/, "") : null,
  jwtSecret,
  mfaEncryptionKey,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
  pairingTokenTtlSeconds: Number(process.env.PAIRING_TOKEN_TTL_SECONDS ?? 300),
  deviceFetchTimeoutMs: Number(process.env.DEVICE_FETCH_TIMEOUT_MS ?? 15000),
  rateLimitAuthMax: Number(process.env.RATE_LIMIT_AUTH_MAX ?? 25),
  rateLimitPairMax: Number(process.env.RATE_LIMIT_PAIR_MAX ?? 40),
  storageDir,
};
