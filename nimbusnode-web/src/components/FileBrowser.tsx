import { useEffect, useState } from "react";
import { BrokerClient, FileMeta } from "../api";
import { decryptFile, unwrapDek } from "../crypto";

interface Props {
  client: BrokerClient;
  deviceId: string | null;
  masterKey: string;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

function isPreviewable(mimeType: string | null): boolean {
  if (!mimeType) return false;
  return (
    mimeType.startsWith("image/") ||
    mimeType.startsWith("video/") ||
    mimeType.startsWith("audio/") ||
    mimeType === "application/pdf" ||
    mimeType.startsWith("text/")
  );
}

export function FileBrowser({ client, deviceId, masterKey }: Props) {
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyFileId, setBusyFileId] = useState<string | null>(null);

  async function refresh() {
    try {
      setFiles(await client.listFiles(deviceId ?? undefined));
      setError(null);
    } catch (err: any) {
      setError(err.message ?? "Failed to load files");
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId]);

  async function fetchAndDecrypt(file: FileMeta): Promise<Blob> {
    const { ciphertext, wrappedDek } = await client.downloadFile(file.id);
    const dek = await unwrapDek(masterKey, wrappedDek);
    const plaintext = await decryptFile(dek, ciphertext);
    return new Blob([plaintext], { type: file.mimeType ?? "application/octet-stream" });
  }

  async function handleDownload(file: FileMeta) {
    if (!masterKey) {
      setError("Enter the master key above before downloading.");
      return;
    }
    setBusyFileId(file.id);
    setError(null);
    try {
      const blob = await fetchAndDecrypt(file);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.name;
      a.click();
      // Revoke on a delay — revoking immediately can cancel the download in
      // some browsers before it's actually started reading the blob.
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (err: any) {
      setError(err.message ?? "Download or decryption failed");
    } finally {
      setBusyFileId(null);
    }
  }

  async function handlePreview(file: FileMeta) {
    if (!masterKey) {
      setError("Enter the master key above before previewing.");
      return;
    }
    setBusyFileId(file.id);
    setError(null);
    try {
      const blob = await fetchAndDecrypt(file);
      const url = URL.createObjectURL(blob);
      // Opened in a new tab rather than saved to disk — the object URL
      // (and the decrypted bytes behind it) only exist in this browser tab
      // and are never written anywhere.
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err: any) {
      setError(err.message ?? "Preview failed");
    } finally {
      setBusyFileId(null);
    }
  }

  return (
    <div className="card">
      <h2>Files</h2>
      {error && <p className="error">{error}</p>}
      {files.length === 0 && !error && <p className="muted">No files synced yet.</p>}
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Size</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {files.map((f) => (
            <tr key={f.id}>
              <td>{f.path}</td>
              <td>{formatBytes(f.sizeBytes)}</td>
              <td>
                <span className={`badge ${f.deviceOnline ? "online" : "offline"}`}>
                  {f.deviceOnline ? "live" : "device offline"}
                </span>
              </td>
              <td>
                {isPreviewable(f.mimeType) && (
                  <button
                    className="secondary"
                    onClick={() => handlePreview(f)}
                    disabled={busyFileId === f.id || !f.deviceOnline}
                    style={{ marginRight: 6 }}
                  >
                    {busyFileId === f.id ? "…" : "Preview"}
                  </button>
                )}
                <button
                  onClick={() => handleDownload(f)}
                  disabled={busyFileId === f.id || !f.deviceOnline}
                >
                  {busyFileId === f.id ? "Downloading…" : "Download"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
