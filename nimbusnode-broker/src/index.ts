import cors from "cors";
import express from "express";
import http from "http";
import { config } from "./config";
import { authRouter } from "./routes/auth";
import { devicesRouter } from "./routes/devices";
import { filesRouter } from "./routes/files";
import { attachWebSocketServer } from "./ws/server";

// Last-resort safety net: log and keep running rather than let one bad
// promise rejection anywhere in the app take down every connected device.
// This is not a substitute for fixing specific error paths (see deviceHub.ts
// for the P2025 handling that was actually causing crashes) — just insurance
// against whatever the next one turns out to be.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection (broker kept running):", reason);
});

const app = express();
app.use(cors({ exposedHeaders: ["X-Encrypted-Dek"] }));
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/auth", authRouter);
app.use("/devices", devicesRouter);
app.use("/files", filesRouter);

const httpServer = http.createServer(app);
attachWebSocketServer(httpServer);

httpServer.listen(config.port, () => {
  console.log(`NimbusNode broker listening on :${config.port} (${config.nodeEnv})`);
  console.log(`Device WebSocket endpoint: ws://localhost:${config.port}/ws/device?token=<deviceToken>`);
});