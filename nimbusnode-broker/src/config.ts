import "dotenv/config";
import path from "path";
import fs from "fs";

const nodeEnv = (process.env.NODE_ENV ?? "development").toLowerCase();
const isProduction = nodeEnv === "production";

// Development is intentionally self-contained. Production must always point at PostgreSQL.
if (!isProduction) {
  process.env.DATABASE_URL = "file:./dev.db";
} else if (!process.env.DATABASE_URL?.startsWith("postgresql://") && !process.env.DATABASE_URL?.startsWith("postgres://")) {
  throw new Error("Production requires DATABASE_URL to start with postgresql:// or postgres://");
}

function required(name: string, fallback?: string): string {
  const val = process.env[name] ?? fallback;
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

export const config = {
  port: Number(process.env.PORT ?? 4000),
  nodeEnv,
  jwtSecret: required("JWT_SECRET", "stashly-super-secure-jwt-secret-key-2026"),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
  pairingTokenTtlSeconds: Number(process.env.PAIRING_TOKEN_TTL_SECONDS ?? 300),
  deviceFetchTimeoutMs: Number(process.env.DEVICE_FETCH_TIMEOUT_MS ?? 15000),
  storageDir,
};
