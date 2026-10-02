/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

import cors from "cors";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import http from "http";
import { config } from "./config";
import { authRouter } from "./routes/auth";
import { devicesRouter } from "./routes/devices";
import { filesRouter } from "./routes/files";
import { attachWebSocketServer } from "./ws/server";
import { getLocalIpAddress } from "./utils/network";
import { sharesRouter } from "./routes/shares";

// Last-resort safety net: log and keep running rather than let one bad
// promise rejection anywhere in the app take down every connected device.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection (broker kept running):", reason);
});

const app = express();

app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
}));

app.use(cors({ exposedHeaders: ["X-Encrypted-Dek", "X-From-Local-Cache"] }));
app.use(express.json({ limit: "50mb" }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: config.rateLimitAuthMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many authentication attempts. Please try again later." },
});

const pairingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: config.rateLimitPairMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many pairing attempts. Please try again later." },
});

app.get("/health", (_req, res) => res.json({ ok: true, status: "healthy", service: "stashly-broker" }));

app.get("/info", (req, res) => {
  const host = req.get("host") || `localhost:${config.port}`;
  const protocol = req.protocol === "https" || req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
  const hostname = host.split(":")[0].toLowerCase();
  const isPrivateHost = hostname === "localhost" || hostname === "127.0.0.1" ||
    hostname.startsWith("10.") || hostname.startsWith("192.168.") ||
    hostname.startsWith("172.");
  const publicUrl = config.publicUrl || (!isPrivateHost ? `${protocol}://${host}` : null);
  const isProd = config.nodeEnv === "production" || !!publicUrl;
  const localIp = getLocalIpAddress();
  const localLanUrl = `http://${localIp}:${config.port}`;
  const suggestedBrokerUrl = publicUrl || localLanUrl;

  res.json({
    ok: true,
    service: "stashly-broker",
    nodeEnv: config.nodeEnv,
    isProduction: isProd,
    publicUrl,
    localLanUrl,
    localIp,
    port: config.port,
    suggestedBrokerUrl
  });
});

app.use("/auth", authLimiter, authRouter);
app.use("/devices/pairing-tokens", pairingLimiter);
app.use("/devices/pair", pairingLimiter);
app.use("/devices", devicesRouter);
app.use("/files", filesRouter);
app.use("/shares", sharesRouter);
app.use("/share", sharesRouter);

const httpServer = http.createServer(app);
attachWebSocketServer(httpServer);

httpServer.listen(config.port, () => {
  const localIp = getLocalIpAddress();
  const lanUrl = `http://${localIp}:${config.port}`;
  const publicUrl = process.env.PUBLIC_URL || null;

  console.log("==================================================");
  console.log(`🚀 STASHLY BROKER RUNNING (${config.nodeEnv})`);
  console.log(`   • Localhost:       http://localhost:${config.port}`);
  console.log(`   • Network LAN:     ${lanUrl}`);
  if (publicUrl) {
    console.log(`   • Public/Deployed: ${publicUrl}`);
  }
  console.log(`   • Storage cache:   ${config.storageDir}`);
  console.log("==================================================");
});
