import "dotenv/config";

function required(name: string, fallback?: string): string {
  const val = process.env[name] ?? fallback;
  if (val === undefined) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return val;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  nodeEnv: process.env.NODE_ENV ?? "development",
  jwtSecret: required("JWT_SECRET"),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
  pairingTokenTtlSeconds: Number(process.env.PAIRING_TOKEN_TTL_SECONDS ?? 300),
  deviceFetchTimeoutMs: Number(process.env.DEVICE_FETCH_TIMEOUT_MS ?? 15000),
};
