import cors from "cors";
import express from "express";
import http from "http";
import { config } from "./config";
import { authRouter } from "./routes/auth";
import { devicesRouter } from "./routes/devices";
import { filesRouter } from "./routes/files";
import { attachWebSocketServer } from "./ws/server";
import { getLocalIpAddress } from "./utils/network";

// Last-resort safety net: log and keep running rather than let one bad
// promise rejection anywhere in the app take down every connected device.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection (broker kept running):", reason);
});

const app = express();
app.use(cors({ exposedHeaders: ["X-Encrypted-Dek", "X-From-Local-Cache"] }));
app.use(express.json({ limit: "10mb" }));

app.get("/health", (_req, res) => res.json({ ok: true, status: "healthy", service: "stashly-broker" }));

app.get("/info", (req, res) => {
  const isProd = config.nodeEnv === "production" || !!process.env.PUBLIC_URL;
  const host = req.get("host") || `localhost:${config.port}`;
  const protocol = req.protocol === "https" || req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
  
  const publicUrl = process.env.PUBLIC_URL || (isProd ? `${protocol}://${host}` : null);
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

app.use("/auth", authRouter);
app.use("/devices", devicesRouter);
app.use("/files", filesRouter);

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