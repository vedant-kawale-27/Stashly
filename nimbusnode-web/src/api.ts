// Thin wrapper around the broker's REST API (see the broker's
// src/routes/*.ts for the authoritative shapes).

export interface Device {
  id: string;
  name: string;
  status: "online" | "offline";
  storageQuotaMb: number;
  createdAt: string;
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
}

export interface DownloadedFile {
  ciphertext: ArrayBuffer;
  wrappedDek: string;
}

class ApiError extends Error {}

async function parseJsonOrThrow<T = Record<string, unknown>>(res: Response): Promise<T> {
  const text = await res.text();
  let json: { error?: string } & T = {} as { error?: string } & T;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      if (!res.ok) {
        throw new ApiError(`Request failed (HTTP ${res.status})`);
      }
    }
  }
  if (!res.ok) {
    throw new ApiError(json.error ?? `Request failed (HTTP ${res.status})`);
  }
  return json;
}

export class BrokerClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string, private token?: string) {
    this.baseUrl = baseUrl.trim().replace(/\/+$/, "");
  }

  withToken(token: string): BrokerClient {
    return new BrokerClient(this.baseUrl, token);
  }

  private authHeaders(): HeadersInit {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
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
    const res = await fetch(url, { headers: this.authHeaders() });
    return parseJsonOrThrow(res);
  }

  async downloadFile(fileId: string): Promise<DownloadedFile> {
    const res = await fetch(`${this.baseUrl}/files/${fileId}/download`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new ApiError(json.error ?? `Download failed (HTTP ${res.status})`);
    }
    const wrappedDek = res.headers.get("X-Encrypted-Dek");
    if (!wrappedDek) {
      throw new ApiError(
        "Broker didn't send X-Encrypted-Dek — is exposedHeaders set in its CORS config?"
      );
    }
    const ciphertext = await res.arrayBuffer();
    return { ciphertext, wrappedDek };
  }
}
