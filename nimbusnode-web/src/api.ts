// Stashly API Client

export interface SharedUser {
  userId: string;
  email: string;
  role: string;
  since: string;
}

export interface Device {
  id: string;
  name: string;
  platform: string;
  osVersion: string | null;
  appVersion: string | null;
  status: "online" | "offline";
  storageQuotaMb: number;
  createdAt: string;
  lastSeenAt?: string | null;
  fileCount?: number;
  role?: string;
  sharedWith?: SharedUser[];
}

export interface FileMeta {
  id: string;
  deviceId: string;
  path: string;
  name: string;
  sizeBytes: number;
  contentHash: string;
  mimeType: string | null;
  encryptedDek: string;
  deviceOnline: boolean;
  isCached?: boolean;
  cachedAt?: string | null;
  lastAccessAt?: string | null;
}

export interface DownloadedFile {
  ciphertext: ArrayBuffer;
  wrappedDek: string;
  fromCache?: boolean;
}

export class ApiError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "ApiError";
  }
}

async function parseJsonOrThrow<T = Record<string, unknown>>(res: Response): Promise<T> {
  const text = await res.text();
  let json: { error?: string } & T = {} as { error?: string } & T;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      if (!res.ok) {
        throw new ApiError(`Request failed (HTTP ${res.status})`, res.status);
      }
    }
  }
  if (!res.ok) {
    throw new ApiError(json.error ?? `Request failed (HTTP ${res.status})`, res.status);
  }
  return json;
}

export interface BrokerInfo {
  ok: boolean;
  service: string;
  nodeEnv: string;
  isProduction: boolean;
  publicUrl: string | null;
  localLanUrl: string;
  localIp: string;
  port: number;
  suggestedBrokerUrl: string;
}

export class BrokerClient {
  public readonly baseUrl: string;

  constructor(baseUrl: string, private token?: string) {
    // Clean up baseUrl
    this.baseUrl = (baseUrl || "").trim().replace(/\/+$/, "");
  }

  withToken(token: string): BrokerClient {
    return new BrokerClient(this.baseUrl, token);
  }

  private authHeaders(): HeadersInit {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  async health(): Promise<{ ok: boolean; service?: string }> {
    const res = await fetch(`${this.baseUrl}/health`);
    return parseJsonOrThrow(res);
  }

  async fetchInfo(): Promise<BrokerInfo> {
    const res = await fetch(`${this.baseUrl}/info`);
    return parseJsonOrThrow<BrokerInfo>(res);
  }

  async register(email: string, password: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const json = await parseJsonOrThrow<{ token: string }>(res);
    return json.token;
  }

  async login(email: string, password: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const json = await parseJsonOrThrow<{ token: string }>(res);
    return json.token;
  }

  async createPairingToken(): Promise<{ token: string; expiresAt: string }> {
    const res = await fetch(`${this.baseUrl}/devices/pairing-tokens`, {
      method: "POST",
      headers: this.authHeaders(),
    });
    return parseJsonOrThrow(res);
  }

  async listDevices(): Promise<Device[]> {
    const res = await fetch(`${this.baseUrl}/devices`, { headers: this.authHeaders() });
    return parseJsonOrThrow(res);
  }

  async renameDevice(deviceId: string, name: string): Promise<{ id: string; name: string }> {
    const res = await fetch(`${this.baseUrl}/devices/${deviceId}`, {
      method: "PATCH",
      headers: { ...this.authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    return parseJsonOrThrow(res);
  }

  async unpairDevice(deviceId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/devices/${deviceId}`, {
      method: "DELETE",
      headers: this.authHeaders(),
    });
    if (!res.ok && res.status !== 204) await parseJsonOrThrow(res);
  }

  async listFiles(deviceId?: string): Promise<FileMeta[]> {
    const url = new URL(`${this.baseUrl}/files`);
    if (deviceId) url.searchParams.set("deviceId", deviceId);
    const res = await fetch(url.toString(), { headers: this.authHeaders() });
    return parseJsonOrThrow(res);
  }

  async downloadFile(fileId: string): Promise<DownloadedFile> {
    const res = await fetch(`${this.baseUrl}/files/${fileId}/download`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new ApiError(json.error ?? `Download failed (HTTP ${res.status})`, res.status);
    }
    const wrappedDek = res.headers.get("X-Encrypted-Dek");
    if (!wrappedDek) {
      throw new ApiError(
        "Broker didn't return encryption metadata (X-Encrypted-Dek)"
      );
    }
    const fromCache = res.headers.get("X-From-Local-Cache") === "true";
    const ciphertext = await res.arrayBuffer();
    return { ciphertext, wrappedDek, fromCache };
  }
}
