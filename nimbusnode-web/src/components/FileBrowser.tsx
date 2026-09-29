import React, { useEffect, useState } from "react";
import { BrokerClient, FileMeta } from "../api";
import { base64ToBytes, decryptFile, unwrapDek } from "../crypto";

interface Props {
  client: BrokerClient;
  deviceId: string | null;
  masterKey: string;
  onMasterKeyChange: (key: string) => void;
  onClearLocalKeyData: () => Promise<void>;
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

function getFileIcon(name: string, mimeType: string | null): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext) || mimeType?.startsWith("image/")) return "🖼️";
  if (["mp4", "mkv", "webm", "mov"].includes(ext) || mimeType?.startsWith("video/")) return "🎬";
  if (["mp3", "wav", "ogg", "m4a"].includes(ext) || mimeType?.startsWith("audio/")) return "🎵";
  if (["pdf"].includes(ext) || mimeType === "application/pdf") return "📕";
  if (["zip", "tar", "gz", "rar"].includes(ext)) return "📦";
  if (["ts", "tsx", "js", "html", "css", "json", "py", "kt"].includes(ext)) return "💻";
  return "📄";
}

function isPreviewable(name: string, mimeType: string | null): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "txt", "md", "json", "pdf", "mp4", "mp3"].includes(ext)) return true;
  if (!mimeType) return false;
  return (
    mimeType.startsWith("image/") ||
    mimeType.startsWith("video/") ||
    mimeType.startsWith("audio/") ||
    mimeType === "application/pdf" ||
    mimeType.startsWith("text/")
  );
}

function isDirectoryEntry(file: FileMeta): boolean {
  return file.mimeType === "inode/directory" || file.mimeType === "directory" || file.contentHash === "directory";
}

function pathSegments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function isInsidePath(filePath: string, folderPath: string): boolean {
  const fileSegments = pathSegments(filePath);
  const folderSegments = pathSegments(folderPath);
  return folderSegments.every((segment, index) => fileSegments[index] === segment);
}

export function FileBrowser({ client, deviceId, masterKey, onMasterKeyChange, onClearLocalKeyData }: Props) {
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyFileId, setBusyFileId] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [showKeyDrawer, setShowKeyDrawer] = useState(false);
  const [tempKey, setTempKey] = useState("");
  const [validatingKey, setValidatingKey] = useState(false);
  const [showKey, setShowKey] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      setFiles(await client.listFiles(deviceId ?? undefined));
      setError(null);
    } catch (err: any) {
      setError(err.message ?? "Failed to query vault files");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setCurrentPath("");
    setFiles([]);
    setTempKey("");
    setShowKey(false);
    setError(null);
    refresh();
  }, [deviceId]);

  async function fetchAndDecrypt(file: FileMeta): Promise<Blob> {
    const { ciphertext, wrappedDek } = await client.downloadFile(file.id);
    const dek = await unwrapDek(masterKey.trim(), wrappedDek);
    const plaintext = await decryptFile(dek, ciphertext);
    return new Blob([plaintext], { type: file.mimeType ?? "application/octet-stream" });
  }

  async function applyMasterKey() {
    const candidate = (tempKey || masterKey).trim();
    setError(null);

    try {
      const rawKey = base64ToBytes(candidate);
      if (rawKey.length !== 32) {
        throw new Error("The master key must decode to exactly 32 bytes (AES-256).");
      }

      const testFiles = files.filter((file) => !isDirectoryEntry(file)).slice(0, 5);
      if (testFiles.length === 0) {
        onMasterKeyChange(candidate);
        setShowKeyDrawer(false);
        setError("The key format is valid, but it cannot be fully verified until an accessible file is available.");
        return;
      }

      setValidatingKey(true);
      let verified = false;
      let contentError = false;
      let lastError: any = null;

      for (const testFile of testFiles) {
        try {
          const { ciphertext, wrappedDek } = await client.downloadFile(testFile.id);
          const dek = await unwrapDek(candidate, wrappedDek);
          verified = true;
          try {
            await decryptFile(dek, ciphertext);
          } catch {
            contentError = true;
          }
          break;
        } catch (err: any) {
          lastError = err;
          if (err.code === "DEVICE_OFFLINE_NO_CACHE" || err.code === "DEVICE_TIMEOUT_NO_CACHE") break;
        }
      }

      if (!verified) {
        throw lastError ?? new Error("The master key could not be verified against the available files.");
      }

      onMasterKeyChange(candidate);
      setShowKeyDrawer(false);
      setError(contentError
        ? "Master key verified. Some stored file data is stale or corrupted, so it could not be decrypted."
        : null);
    } catch (err: any) {
      if (err.code === "DEVICE_OFFLINE_NO_CACHE" || err.code === "DEVICE_TIMEOUT_NO_CACHE") {
        setError(`${err.message}. The master key was not changed because it could not be verified.`);
      } else if (err.name === "OperationError" || err.name === "DataError") {
        setError("This master key is incorrect for the selected storage node.");
      } else {
        setError(err.message ?? "Could not verify the master key.");
      }
    } finally {
      setValidatingKey(false);
    }
  }

  async function handleDownload(file: FileMeta) {
    if (!masterKey.trim()) {
      setShowKeyDrawer(true);
      setError("Please configure your Master Key to decrypt this file.");
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
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (err: any) {
      setError(err.code === "DEVICE_OFFLINE_NO_CACHE" || err.code === "DEVICE_TIMEOUT_NO_CACHE"
        ? `${err.message}. Check that the phone is connected to the same broker URL as this web session.`
        : err.message ?? "Download or decryption failed");
    } finally {
      setBusyFileId(null);
    }
  }

  async function handlePreview(file: FileMeta) {
    if (!masterKey.trim()) {
      setShowKeyDrawer(true);
      setError("Please configure your Master Key to decrypt this file.");
      return;
    }
    setBusyFileId(file.id);
    setError(null);
    try {
      const blob = await fetchAndDecrypt(file);
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err: any) {
      setError(err.code === "DEVICE_OFFLINE_NO_CACHE" || err.code === "DEVICE_TIMEOUT_NO_CACHE"
        ? `${err.message}. Check that the phone is connected to the same broker URL as this web session.`
        : err.message ?? "Decryption preview failed — verify Master Key.");
    } finally {
      setBusyFileId(null);
    }
  }

  const isDirectoryItem = isDirectoryEntry;

  const filteredFiles = searchQuery.trim()
    ? files.filter((f) => f.name.toLowerCase().includes(searchQuery.toLowerCase()) || f.path.toLowerCase().includes(searchQuery.toLowerCase()))
    : null;

  const currentSegments = pathSegments(currentPath);
  const folderMap = new Map<string, string>();
  const visibleFiles: FileMeta[] = [];

  if (!filteredFiles) {
    for (const file of files) {
      if (!isInsidePath(file.path, currentPath)) continue;
      const segments = pathSegments(file.path);
      if (segments.length <= currentSegments.length) continue;

      const remainingSegments = segments.slice(currentSegments.length);
      if (remainingSegments.length === 1) {
        if (isDirectoryItem(file)) {
          const folderName = remainingSegments[0];
          const folderPath = [...currentSegments, folderName].join("/");
          folderMap.set(folderPath, folderName);
        } else {
          visibleFiles.push(file);
        }
      } else {
        const folderName = remainingSegments[0];
        const folderPath = [...currentSegments, folderName].join("/");
        folderMap.set(folderPath, folderName);
      }
    }
  }

  const visibleFolders = [...folderMap.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  if (!filteredFiles) {
    visibleFiles.sort((a, b) => a.name.localeCompare(b.name));
  }

  const displayFileList = filteredFiles
    ? filteredFiles.filter((f) => !isDirectoryItem(f))
    : visibleFiles;

  const actualFileCount = files.filter((f) => !isDirectoryItem(f)).length;

  return (
    <div className="panel-box">
      <div className="panel-box-header">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <h3 className="panel-box-title">Encrypted Vault Explorer</h3>
          <span className="btn-pill-cyan" style={{ padding: "2px 10px", fontSize: "0.75rem" }}>
            {actualFileCount} {actualFileCount === 1 ? "File" : "Files"}
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            className={masterKey ? "btn-pill-cyan" : "btn-secondary btn-small"}
            onClick={() => setShowKeyDrawer(!showKeyDrawer)}
            title="Configure Master Key"
          >
            🔑 {masterKey ? "Master Key Configured" : "Set Master Key"}
          </button>

          <button className="btn-icon" onClick={refresh} title="Refresh files">
            🔄
          </button>
        </div>
      </div>

      <div className="panel-box-body">
        {/* Master Key Drawer */}
        {showKeyDrawer && (
          <div style={{
            background: "var(--bg-card-subtle)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-md)",
            padding: "16px",
            marginBottom: 16
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <span style={{ fontSize: "0.85rem", fontWeight: 700 }}>Device Master Key (Base64 AES-256)</span>
              <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Kept in local browser memory only</span>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input
                type={showKey ? "text" : "password"}
                placeholder="Paste 32-byte Base64 key from Android app…"
                value={tempKey || masterKey}
                onChange={(e) => setTempKey(e.target.value)}
                style={{
                  flex: 1,
                  padding: "8px 12px",
                  fontSize: "0.85rem",
                  fontFamily: "var(--font-mono)",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--border-subtle)",
                  background: "var(--bg-card)",
                  color: "var(--text-main)"
                }}
              />
              <button
                className="btn-secondary btn-small"
                type="button"
                onClick={() => setShowKey((visible) => !visible)}
                title={showKey ? "Hide master key" : "Show master key"}
              >
                {showKey ? "Hide" : "Show"}
              </button>
              <button
                className="btn-primary btn-small"
                onClick={() => void applyMasterKey()}
                disabled={validatingKey}
              >
                {validatingKey ? "Verifying..." : "Verify & Apply Key"}
              </button>
              {masterKey && (
                <button
                  className="btn-secondary btn-small"
                  style={{ color: "#ef4444" }}
                  onClick={() => {
                    onMasterKeyChange("");
                    setTempKey("");
                  }}
                >
                  Clear
                </button>
              )}
              <button
                className="btn-secondary btn-small"
                type="button"
                onClick={async () => {
                  if (!confirm("Clear all saved master keys and browser cache? Android files and broker data will not be deleted.")) return;
                  await onClearLocalKeyData();
                  setTempKey("");
                  setShowKey(false);
                  setError("Saved master keys and browser cache cleared. Enter the key again to verify it.");
                }}
              >
                Clear Local Data
              </button>
            </div>
          </div>
        )}

        {error && (
          <div style={{ background: "rgba(239, 68, 68, 0.15)", color: "#ef4444", padding: "10px 14px", borderRadius: "var(--radius-sm)", fontSize: "0.85rem", marginBottom: 14 }}>
            {error}
          </div>
        )}

        {/* Search & Breadcrumbs */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
          <input
            type="text"
            placeholder="Search files by name or path…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              flex: 1,
              padding: "8px 14px",
              borderRadius: "var(--radius-full)",
              border: "1px solid var(--border-subtle)",
              background: "var(--bg-card-subtle)",
              color: "var(--text-main)",
              fontSize: "0.88rem",
              outline: "none"
            }}
          />
        </div>

        {!searchQuery && (
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: "0.85rem",
            padding: "8px 14px",
            background: "var(--bg-card-subtle)",
            borderRadius: "var(--radius-sm)",
            marginBottom: 14
          }}>
            <button
              style={{ background: "none", color: "var(--primary)", fontWeight: 700, padding: 0 }}
              onClick={() => setCurrentPath("")}
            >
              Vault Root
            </button>
            {currentSegments.map((segment, index) => {
              const path = currentSegments.slice(0, index + 1).join("/");
              return (
                <React.Fragment key={path}>
                  <span style={{ color: "var(--text-muted)" }}>/</span>
                  <button
                    style={{ background: "none", color: "var(--primary)", fontWeight: 600, padding: 0 }}
                    onClick={() => setCurrentPath(path)}
                  >
                    {segment}
                  </button>
                </React.Fragment>
              );
            })}
          </div>
        )}

        {/* File Table */}
        {loading && files.length === 0 ? (
          <div style={{ textAlign: "center", padding: "36px 0", color: "var(--text-muted)", fontSize: "0.88rem" }}>
            Scanning encrypted vault files…
          </div>
        ) : files.length === 0 ? (
          <div style={{ textAlign: "center", padding: "36px 0", color: "var(--text-muted)" }}>
            <div style={{ fontSize: "2rem", marginBottom: 8 }}>📁</div>
            <h4 style={{ color: "var(--text-main)", marginBottom: 4 }}>No files synced yet</h4>
            <p style={{ fontSize: "0.85rem" }}>Files indexed on your connected phone will appear here.</p>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="vault-table">
              <thead>
                <tr>
                  <th>File Name</th>
                  <th>Virtual Path</th>
                  <th>Size</th>
                  <th>Availability</th>
                  <th style={{ textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {!searchQuery && visibleFolders.length === 0 && displayFileList.length === 0 && (
                  <tr>
                    <td colSpan={5} style={{ textAlign: "center", padding: "36px 0", color: "var(--text-muted)" }}>
                      <div style={{ fontSize: "1.6rem", marginBottom: 6 }}>📂</div>
                      <div style={{ fontWeight: 600, color: "var(--text-main)", marginBottom: 4 }}>This folder is empty</div>
                      <div style={{ fontSize: "0.82rem" }}>No files or subdirectories found inside {currentPath ? `/${currentPath}` : "this folder"}.</div>
                    </td>
                  </tr>
                )}

                {!searchQuery &&
                  visibleFolders.map(([path, name]) => (
                    <tr
                      key={path}
                      style={{ cursor: "pointer" }}
                      onClick={() => setCurrentPath(path)}
                    >
                      <td colSpan={2}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, color: "var(--primary)" }}>
                          <span>📁</span>
                          <span>{name}</span>
                        </div>
                      </td>
                      <td style={{ color: "var(--text-muted)" }}>—</td>
                      <td><span className="btn-pill-cyan" style={{ padding: "1px 8px", fontSize: "0.72rem" }}>Folder</span></td>
                      <td style={{ textAlign: "right" }}>
                        <button className="btn-secondary btn-small" onClick={() => setCurrentPath(path)}>
                          Open
                        </button>
                      </td>
                    </tr>
                  ))}

                {displayFileList.map((f) => {
                  const canPreview = isPreviewable(f.name, f.mimeType);
                  const isBusy = busyFileId === f.id;
                  const isAvailable = f.deviceOnline || f.isCached;

                  return (
                    <tr key={f.id}>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600 }}>
                          <span>{getFileIcon(f.name, f.mimeType)}</span>
                          <span style={{ color: "var(--text-main)" }}>{f.name}</span>
                        </div>
                      </td>
                      <td className="font-mono" style={{ fontSize: "0.78rem", color: "var(--text-muted)", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {f.path}
                      </td>
                      <td className="font-mono" style={{ fontSize: "0.82rem", color: "var(--text-sub)" }}>
                        {formatBytes(f.sizeBytes)}
                      </td>
                      <td>
                        {f.deviceOnline ? (
                          <span className="badge-e2e">
                            ● Live Stream
                          </span>
                        ) : f.isCached ? (
                          <span className="badge-e2e" style={{ background: "var(--primary-subtle)", color: "var(--primary-text)" }}>
                            💾 Local Cache
                          </span>
                        ) : (
                          <span className="badge-e2e" style={{ background: "rgba(100, 116, 139, 0.15)", color: "var(--text-muted)" }}>
                            Offline
                          </span>
                        )}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
                          {canPreview && (
                            <button
                              className="btn-secondary btn-small"
                              onClick={() => handlePreview(f)}
                              disabled={isBusy || !isAvailable}
                            >
                              {isBusy ? "Decrypting…" : "👁️ Preview"}
                            </button>
                          )}
                          <button
                            className="btn-primary btn-small"
                            onClick={() => handleDownload(f)}
                            disabled={isBusy || !isAvailable}
                          >
                            {isBusy ? "Downloading…" : "⬇️ Download"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
