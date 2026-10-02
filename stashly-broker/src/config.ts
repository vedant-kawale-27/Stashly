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

const nodeEnv = (process.env.NODE_ENV ?? "development").toLowerCase();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl?.startsWith("postgresql://") && !databaseUrl?.startsWith("postgres://")) {
  throw new Error("DATABASE_URL must be a PostgreSQL URL starting with postgresql:// or postgres://");
}

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

export const config = {
  port: Number(process.env.PORT ?? 4000),
  nodeEnv,
  publicUrl: process.env.PUBLIC_URL ? process.env.PUBLIC_URL.trim().replace(/\/+$/, "") : null,
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
  pairingTokenTtlSeconds: Number(process.env.PAIRING_TOKEN_TTL_SECONDS ?? 300),
  deviceFetchTimeoutMs: Number(process.env.DEVICE_FETCH_TIMEOUT_MS ?? 15000),
  rateLimitAuthMax: Number(process.env.RATE_LIMIT_AUTH_MAX ?? 25),
  rateLimitPairMax: Number(process.env.RATE_LIMIT_PAIR_MAX ?? 40),
  storageDir,
};
