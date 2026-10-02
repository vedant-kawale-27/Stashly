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
 * Phones connect to: wss://<broker>/ws/device
 * The device JWT is passed via Authorization header, Sec-WebSocket-Protocol, or query param.
 */
export function attachWebSocketServer(httpServer: HttpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "", "http://localhost");
    if (url.pathname !== "/ws/device") {
      socket.destroy();
      return;
    }

    const authHeader = req.headers.authorization;
    const headerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
    const protoToken = req.headers["sec-websocket-protocol"]?.split(",")[0]?.trim();
    const queryToken = url.searchParams.get("token")?.trim();
    const token = headerToken || protoToken || queryToken;

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
