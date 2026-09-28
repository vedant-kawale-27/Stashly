import os from "os";

/**
 * Dynamically resolves the active non-internal IPv4 LAN address of the host machine.
 * Priority is given to typical private subnets (192.168.x, 10.x, 172.16-31.x).
 */
export function getLocalIpAddress(): string {
  const interfaces = os.networkInterfaces();
  const candidates: string[] = [];

  for (const name of Object.keys(interfaces)) {
    const list = interfaces[name];
    if (!list) continue;
    for (const iface of list) {
      // Check for IPv4 and non-internal (ignore 127.0.0.1)
      if (iface.family === "IPv4" && !iface.internal) {
        candidates.push(iface.address);
      }
    }
  }

  // Find preferred LAN subnet IP (Wi-Fi / Ethernet adapter)
  const preferred = candidates.find(
    (ip) =>
      ip.startsWith("192.168.") ||
      ip.startsWith("10.") ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)
  );

  return preferred || candidates[0] || "127.0.0.1";
}
