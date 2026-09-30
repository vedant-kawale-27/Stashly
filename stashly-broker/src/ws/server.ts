/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

import { Server as HttpServer } from "http";
import { WebSocketServer } from "ws";
import { verifyDeviceToken } from "../auth";
import { deviceHub } from "./deviceHub";

/**
 * Phones connect to: wss://<broker>/ws/device?token=<deviceJwt>
 * The device JWT is issued once, at the end of the pairing flow (see
 * routes/devices.ts), and stored locally on the phone from then on.
 */
export function attachWebSocketServer(httpServer: HttpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "", "http://localhost");
    if (url.pathname !== "/ws/device") {
      socket.destroy();
      return;
    }

    const token = url.searchParams.get("token");
    if (!token) {
      socket.destroy();
      return;
    }

    let deviceId: string;
    try {
      ({ deviceId } = verifyDeviceToken(token));
    } catch {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      deviceHub.registerConnection(deviceId, ws);
    });
  });

  return wss;
}
