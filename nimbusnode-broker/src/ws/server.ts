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
