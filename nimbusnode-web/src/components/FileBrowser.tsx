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

function pathSegments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function isInsidePath(filePath: string, folderPath: string): boolean {
  const fileSegments = pathSegments(filePath);
  const folderSegments = pathSegments(folderPath);
  return folderSegments.every((segment, index) => fileSegments[index] === segment);
}

export function FileBrowser({ client, deviceId, masterKey }: Props) {
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyFileId, setBusyFileId] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState("");

  async function refresh() {
    try {
      setFiles(await client.listFiles(deviceId ?? undefined));
      setError(null);
    } catch (err: any) {
      setError(err.message ?? "Failed to load files");
    }
  }

  useEffect(() => {
    setCurrentPath("");
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

  async function openFile(file: FileMeta) {
    if (isPreviewable(file.mimeType)) {
      await handlePreview(file);
    } else {
      await handleDownload(file);
    }
  }

  const currentSegments = pathSegments(currentPath);
  const folderMap = new Map<string, string>();
  const visibleFiles: FileMeta[] = [];

  for (const file of files) {
    if (!isInsidePath(file.path, currentPath)) continue;
    const segments = pathSegments(file.path);
    if (segments.length <= currentSegments.length) continue;

    const remainingSegments = segments.slice(currentSegments.length);
    if (remainingSegments.length === 1) {
      visibleFiles.push(file);
    } else {
      const folderName = remainingSegments[0];
      const folderPath = [...currentSegments, folderName].join("/");
      folderMap.set(folderPath, folderName);
    }
  }

  const visibleFolders = [...folderMap.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  visibleFiles.sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="card">
      <h2>Files</h2>
      {error && <p className="error">{error}</p>}
      {files.length > 0 && (
        <div className="breadcrumbs" aria-label="Folder path">
          <button className="link-button" onClick={() => setCurrentPath("")}>Home</button>
          {currentSegments.map((segment, index) => {
            const path = currentSegments.slice(0, index + 1).join("/");
            return (
              <span key={path}>
                <span className="breadcrumb-separator">/</span>
                <button className="link-button" onClick={() => setCurrentPath(path)}>{segment}</button>
              </span>
            );
          })}
        </div>
      )}
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
          {visibleFolders.map(([path, name]) => (
            <tr key={path}>
              <td colSpan={4}>
                <button className="file-entry folder-entry" onClick={() => setCurrentPath(path)}>
                  <span aria-hidden="true">[DIR]</span> {name}
                </button>
              </td>
            </tr>
          ))}
          {visibleFiles.map((f) => (
            <tr key={f.id}>
              <td>
                <button className="file-entry" onClick={() => openFile(f)} disabled={busyFileId === f.id}>
                  <span aria-hidden="true">[FILE]</span> {f.name}
                </button>
              </td>
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
          {files.length > 0 && visibleFolders.length === 0 && visibleFiles.length === 0 && (
            <tr><td colSpan={4} className="muted">This folder is empty.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
