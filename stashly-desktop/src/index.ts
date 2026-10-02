import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

interface FileMeta {
  id: string;
  deviceId: string;
  path: string;
  name: string;
  sizeBytes: number;
  contentHash: string;
  mimeType: string | null;
  encryptedDek: string;
}

const broker = (process.env.STASHLY_BROKER_URL ?? "http://localhost:4000").replace(/\/+$/, "");
const token = process.env.STASHLY_TOKEN;
const deviceId = process.env.STASHLY_DEVICE_ID;
const destination = path.resolve(process.env.STASHLY_SYNC_DIR ?? "./stashly-sync");

if (!token || !deviceId) {
  throw new Error("Set STASHLY_TOKEN and STASHLY_DEVICE_ID before syncing.");
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${broker}${url}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`Broker request failed (${response.status})`);
  return response.json() as Promise<T>;
}

async function sync() {
  await mkdir(destination, { recursive: true });
  const files = await request<FileMeta[]>(`/files?deviceId=${encodeURIComponent(deviceId!)}`);
  const manifestPath = path.join(destination, ".stashly-manifest.json");
  const previous: Record<string, string> = await readFile(manifestPath, "utf8")
    .then((value) => JSON.parse(value) as Record<string, string>)
    .catch(() => ({} as Record<string, string>));
  const next: Record<string, string> = {};

  for (const file of files) {
    if (file.mimeType === "inode/directory" || file.contentHash === "directory") continue;
    const output = path.join(destination, file.path.replace(/^[/\\]+/, "").replace(/\.\.(\/|\\)/g, ""));
    next[file.id] = file.contentHash;
    if (previous[file.id] === file.contentHash) continue;
    const response = await fetch(`${broker}/files/${encodeURIComponent(file.id)}/download`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`Download failed for ${file.path} (${response.status})`);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, Buffer.from(await response.arrayBuffer()));
    console.log(`Synced encrypted file: ${file.path}`);
  }
  await writeFile(manifestPath, JSON.stringify(next, null, 2));
}

if (process.argv[2] !== "sync") {
  throw new Error("Usage: npm run sync");
}
await sync();
