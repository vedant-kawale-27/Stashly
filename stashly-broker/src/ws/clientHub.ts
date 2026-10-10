/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

import { WebSocket } from "ws";
import { prisma } from "../db";

class ClientHub {
  private sockets = new Map<string, Set<WebSocket>>();

  registerConnection(userId: string, socket: WebSocket) {
    let userSockets = this.sockets.get(userId);
    if (!userSockets) {
      userSockets = new Set();
      this.sockets.set(userId, userSockets);
    }
    userSockets.add(socket);

    socket.on("close", () => {
      userSockets?.delete(socket);
      if (userSockets?.size === 0 && this.sockets.get(userId) === userSockets) {
        this.sockets.delete(userId);
      }
    });
  }

  pushToUser(userId: string, message: object) {
    const payload = JSON.stringify(message);
    for (const socket of this.sockets.get(userId) ?? []) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      try {
        socket.send(payload);
      } catch {
        // A single stale browser connection must not block other tabs.
      }
    }
  }

  async pushToDeviceClients(deviceId: string, message: object) {
    const users = await prisma.userDevice.findMany({
      where: { deviceId },
      select: { userId: true },
    });
    for (const { userId } of users) this.pushToUser(userId, message);
  }
}

export const clientHub = new ClientHub();
