/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

import React, { useEffect, useRef, useState } from "react";
import { BrokerClient, Device, FileMeta } from "../api";
import { decryptFile, encryptFile, unwrapDek, wrapDek } from "../crypto";
import { getOfflineDownload, saveOfflineDownload } from "../offlineCache";
import { notify } from "../notifications";

interface Props {
  client: BrokerClient;
  deviceId: string | null;
  onSelectDevice: (deviceId: string | null) => void;
  devices: Device[];
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

function formatStorageMb(value?: number | null): string {
  if (value == null || value < 0) return "Unavailable";
  if (value >= 1024) return `${(value / 1024).toFixed(1)} GB`;
  return `${Math.round(value)} MB`;
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

const fileListViewCache = new Map<string, FileMeta[]>();
const trashListViewCache = new Map<string, FileMeta[]>();

export function clearFileListViewCache() {
  fileListViewCache.clear();
  trashListViewCache.clear();
}

function fileCacheKey(deviceId: string | null): string {
  return deviceId ?? "all";
}

function sameFileMeta(left: FileMeta, right: FileMeta): boolean {
  return left.id === right.id &&
    left.deviceId === right.deviceId &&
    left.path === right.path &&
    left.name === right.name &&
    left.sizeBytes === right.sizeBytes &&
    left.contentHash === right.contentHash &&
    left.mimeType === right.mimeType &&
    left.encryptedDek === right.encryptedDek &&
    left.deviceOnline === right.deviceOnline &&
    left.isCached === right.isCached &&
    left.cachedAt === right.cachedAt &&
    left.lastAccessAt === right.lastAccessAt &&
    left.deletedAt === right.deletedAt;
}

function reconcileFiles(previous: FileMeta[], next: FileMeta[]): FileMeta[] {
  const previousById = new Map(previous.map((file) => [file.id, file]));
  return next.map((file) => {
    const existing = previousById.get(file.id);
    return existing && sameFileMeta(existing, file) ? existing : file;
  });
}

export function FileBrowser({ client, deviceId, onSelectDevice, devices, masterKey }: Props) {
  const [viewMode, setViewMode] = useState<"files" | "trash">("files");
  const [files, setFiles] = useState<FileMeta[]>(() => fileListViewCache.get(fileCacheKey(deviceId)) ?? []);
  const [trashFiles, setTrashFiles] = useState<FileMeta[]>(() => trashListViewCache.get(fileCacheKey(deviceId)) ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyFileId, setBusyFileId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [currentPath, setCurrentPath] = useState("");
  const [uploadDestination, setUploadDestination] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const uploadInputRef = useRef<HTMLInputElement>(null);

  async function refresh(force = false, requestDeviceSync = false) {
    setLoading(true);
    try {
      if (requestDeviceSync && deviceId) {
        await client.syncDevice(deviceId).catch(() => undefined);
      }

      const [nextFiles, nextTrash] = await Promise.all([
        client.listFiles(deviceId ?? undefined, force, false),
        client.listTrash(deviceId ?? undefined, force).catch(() => []),
      ]);

      setFiles((previous) => {
        const reconciled = reconcileFiles(previous, nextFiles);
        fileListViewCache.set(fileCacheKey(deviceId), reconciled);
        return reconciled;
      });

      setTrashFiles((previous) => {
        const reconciled = reconcileFiles(previous, nextTrash);
        trashListViewCache.set(fileCacheKey(deviceId), reconciled);
        return reconciled;
      });

      setError(null);
    } catch (err: any) {
      setError(err.message ?? "Failed to query vault files");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setCurrentPath("");
    setUploadDestination("");
    setFiles(fileListViewCache.get(fileCacheKey(deviceId)) ?? []);
    setTrashFiles(trashListViewCache.get(fileCacheKey(deviceId)) ?? []);
    setError(null);
    void refresh(false);
    const interval = window.setInterval(() => void refresh(false), 8_000);
    return () => window.clearInterval(interval);
  }, [deviceId]);

  useEffect(() => {
    setUploadDestination(currentPath);
  }, [currentPath]);

  async function fetchAndDecrypt(file: FileMeta): Promise<Blob> {
    let downloaded;
    try {
      downloaded = await client.downloadFile(file.id);
      await saveOfflineDownload(file, downloaded.ciphertext, downloaded.wrappedDek).catch(() => undefined);
      if (!downloaded.fromCache) notify("Stashly download cached", `${file.name} is available while offline.`);
    } catch (networkError) {
      const cached = await getOfflineDownload(file.id);
      if (!cached) throw networkError;
      downloaded = { ciphertext: cached.ciphertext, wrappedDek: cached.wrappedDek, fromCache: true };
    }
    const { ciphertext, wrappedDek } = downloaded;
    const dek = await unwrapDek(masterKey.trim(), wrappedDek);
    const plaintext = await decryptFile(dek, ciphertext);
    return new Blob([plaintext], { type: file.mimeType ?? "application/octet-stream" });
  }

  async function handleDelete(file: FileMeta) {
    if (!confirm(`Move "${file.name}" to the Android Recycle Bin? You can restore it anytime.`)) {
      return;
    }

    setBusyFileId(file.id);
    setError(null);
    try {
      await client.deleteFile(file.id);
      setFiles((prev) => {
        const nextFiles = prev.filter((item) => item.id !== file.id);
        fileListViewCache.set(fileCacheKey(deviceId), nextFiles);
        return nextFiles;
      });
      setTrashFiles((prev) => {
        const nextTrash = [{ ...file, deletedAt: new Date().toISOString() }, ...prev];
        trashListViewCache.set(fileCacheKey(deviceId), nextTrash);
        return nextTrash;
      });
      setError(`Moved "${file.name}" to Android Recycle Bin.`);
      setTimeout(() => void refresh(true, true), 600);
    } catch (err: any) {
      setError(err.message ?? "Failed to move file to Recycle Bin");
    } finally {
      setBusyFileId(null);
    }
  }

  async function handleRestore(file: FileMeta) {
    setBusyFileId(file.id);
    setError(null);
    try {
      await client.restoreFile(file.id);
      setTrashFiles((prev) => {
        const nextTrash = prev.filter((item) => item.id !== file.id);
        trashListViewCache.set(fileCacheKey(deviceId), nextTrash);
        return nextTrash;
      });
      setFiles((prev) => {
        const nextFiles = [{ ...file, deletedAt: null }, ...prev];
        fileListViewCache.set(fileCacheKey(deviceId), nextFiles);
        return nextFiles;
      });
      setError(`Restored "${file.name}" back to Android storage.`);
      setTimeout(() => void refresh(true, true), 600);
    } catch (err: any) {
      setError(err.message ?? "Failed to restore file");
    } finally {
      setBusyFileId(null);
    }
  }

  async function handlePermanentDelete(file: FileMeta) {
    if (!confirm(`Permanently erase "${file.name}" from your Android phone? This action CANNOT be undone.`)) {
      return;
    }

    setBusyFileId(file.id);
    setError(null);
    try {
      await client.deletePermanently(file.id);
      setTrashFiles((prev) => {
        const nextTrash = prev.filter((item) => item.id !== file.id);
        trashListViewCache.set(fileCacheKey(deviceId), nextTrash);
        return nextTrash;
      });
      setError(`Permanently deleted "${file.name}" from Android storage.`);
      setTimeout(() => void refresh(true, true), 600);
    } catch (err: any) {
      setError(err.message ?? "Failed to delete file permanently");
    } finally {
      setBusyFileId(null);
    }
  }

  async function handleEmptyTrash() {
    if (trashFiles.length === 0) return;
    if (!confirm(`Permanently delete all ${trashFiles.length} item(s) in the Android Recycle Bin? This action CANNOT be undone.`)) {
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await client.emptyTrash(deviceId ?? undefined);
      setTrashFiles([]);
      trashListViewCache.set(fileCacheKey(deviceId), []);
      setError("Android Recycle Bin emptied successfully.");
      setTimeout(() => void refresh(true, true), 600);
    } catch (err: any) {
      setError(err.message ?? "Failed to empty Recycle Bin");
    } finally {
      setLoading(false);
    }
  }

  async function handleShare(file: FileMeta) {
    try {
      const share = await client.createShare(file.id, file.deviceId);
      await navigator.clipboard?.writeText(share.url);
      setError(`Share link copied. It expires ${new Date(share.expiresAt).toLocaleString()}.`);
    } catch (err: any) {
      setError(err.message ?? "Could not create share link.");
    }
  }

  async function handleDownload(file: FileMeta) {
    if (!masterKey.trim()) {
      setError("Open Devices, select this device, and configure its master key first.");
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
      setError("Open Devices, select this device, and configure its master key first.");
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

  async function handleUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0];
    event.target.value = "";
    if (!selected || !deviceId) return;
    if (!masterKey.trim()) {
      setError("Open Devices, select this device, and configure its master key first.");
      return;
    }
    if (selected.size > 30 * 1024 * 1024) {
      setError("Uploads are limited to 30 MB.");
      return;
    }

    setUploading(true);
    setError(null);
    try {
      const { ciphertext, dek } = await encryptFile(await selected.arrayBuffer());
      const encryptedDek = await wrapDek(masterKey.trim(), dek);
      const destination = uploadDestination.trim() || "/";
      await client.uploadFile(deviceId, destination, selected.name, selected.type || null, ciphertext, encryptedDek);
      setError(`Uploaded ${selected.name} to ${destination === "/" ? "the device root" : destination}.`);
      window.setTimeout(() => void refresh(true), 800);
    } catch (err: any) {
      setError(err.message ?? "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  const isDirectoryItem = isDirectoryEntry;

  // Active files hierarchy computation
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

  // Trashed files filtering
  const filteredTrashFiles = searchQuery.trim()
    ? trashFiles.filter((f) => f.name.toLowerCase().includes(searchQuery.toLowerCase()) || f.path.toLowerCase().includes(searchQuery.toLowerCase()))
    : trashFiles;

  return (
    <div className="panel-box">
      <div className="panel-box-header">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <h3 className="panel-box-title">
            {viewMode === "files" ? "Your files" : "Android Recycle Bin"}
          </h3>
          <span className="btn-pill-cyan" style={{ padding: "2px 10px", fontSize: "0.75rem" }}>
            {viewMode === "files" ? `${actualFileCount} ${actualFileCount === 1 ? "File" : "Files"}` : `${trashFiles.length} Trashed`}
          </span>

          {/* View Toggle */}
          <button
            className={`btn-small ${viewMode === "trash" ? "btn-primary" : "btn-secondary"}`}
            style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 6 }}
            onClick={() => setViewMode((mode) => (mode === "files" ? "trash" : "files"))}
            title={viewMode === "files" ? "Open Android Recycle Bin" : "Back to active files"}
          >
            <span>{viewMode === "files" ? "🗑️ Recycle Bin" : "📁 View Files"}</span>
            {viewMode === "files" && trashFiles.length > 0 && (
              <span style={{
                background: "rgba(239, 68, 68, 0.2)",
                color: "#ef4444",
                padding: "0 6px",
                borderRadius: "10px",
                fontSize: "0.72rem",
                fontWeight: 700
              }}>
                {trashFiles.length}
              </span>
            )}
          </button>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {viewMode === "files" ? (
            <>
              <input
                ref={uploadInputRef}
                type="file"
                hidden
                onChange={(event) => void handleUpload(event)}
              />
              <input
                aria-label="Android upload destination"
                value={uploadDestination ? `/${uploadDestination.replace(/^\/+/, "")}` : "/"}
                onChange={(event) => setUploadDestination(event.target.value.replace(/^\/+/, ""))}
                placeholder="/Android folder"
                style={{
                  width: 170,
                  padding: "7px 10px",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: "var(--radius-sm)",
                  background: "var(--bg-card-subtle)",
                  color: "var(--text-main)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.76rem",
                }}
              />
              <button
                className="btn-primary btn-small"
                type="button"
                disabled={!deviceId || uploading}
                onClick={() => uploadInputRef.current?.click()}
                title={`Upload to ${uploadDestination ? `/${uploadDestination}` : "device root"}`}
              >
                {uploading ? "Uploading..." : "Upload file"}
              </button>
            </>
          ) : (
            <>
              {trashFiles.length > 0 && (
                <button
                  className="btn-secondary btn-small"
                  style={{ color: "#ef4444", borderColor: "rgba(239, 68, 68, 0.4)" }}
                  onClick={() => void handleEmptyTrash()}
                  disabled={loading}
                >
                  Empty Recycle Bin
                </button>
              )}
            </>
          )}

          <span className="device-card-help file-device-key-status">
            🔑 {masterKey ? "Master Key Configured" : "Set Master Key"}
          </span>

          <button className="btn-icon" onClick={() => void refresh(true, true)} title="Sync latest files from Android">
            🔄
          </button>
        </div>
      </div>

      <div className="file-browser-layout">
        <aside className="file-device-sidebar" aria-label="Linked devices">
          <div className="file-device-sidebar-heading">
            <span className="eyebrow">Storage</span>
            <strong>Linked devices</strong>
          </div>
          {devices.length === 0 ? (
            <p className="file-device-sidebar-empty">No linked devices found.</p>
          ) : (
            <div className="file-device-list">
              {devices.map((device) => {
                const hasStorage = device.storageTotalMb != null && device.storageFreeMb != null && device.storageTotalMb > 0;
                const usedMb = hasStorage ? Math.max(0, device.storageTotalMb! - device.storageFreeMb!) : 0;
                const usedPercent = hasStorage ? Math.min(100, Math.max(0, (usedMb / device.storageTotalMb!) * 100)) : 0;
                const isSelected = device.id === deviceId;
                return (
                  <button
                    key={device.id}
                    className={`file-device-item${isSelected ? " selected" : ""}`}
                    onClick={() => onSelectDevice(device.id)}
                    type="button"
                  >
                    <span className="file-device-item-top">
                      <span className="file-device-icon">{device.platform === "windows" ? "💻" : "📱"}</span>
                      <span className="file-device-name" title={device.name}>{device.name}</span>
                      <span className={`file-device-status${device.status === "online" ? " online" : ""}`} />
                    </span>
                    <span className="file-device-storage">
                      <span className="file-device-storage-track">
                        <span className="file-device-storage-fill" style={{ width: `${usedPercent}%` }} />
                      </span>
                      <span className="file-device-storage-label">
                        {hasStorage ? `${formatStorageMb(usedMb)} used` : "Storage unavailable"}
                      </span>
                      {hasStorage && <span className="file-device-storage-total">of {formatStorageMb(device.storageTotalMb)}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          <button
            className="file-device-all-button"
            type="button"
            onClick={() => onSelectDevice(null)}
          >
            <span>▣</span>
            All linked devices
          </button>
        </aside>

        <div className="panel-box-body file-browser-main">
        {error && (
          <div style={{ background: "rgba(239, 68, 68, 0.15)", color: "#ef4444", padding: "10px 14px", borderRadius: "var(--radius-sm)", fontSize: "0.85rem", marginBottom: 14 }}>
            {error}
          </div>
        )}

        {/* Search Bar */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
          <input
            type="text"
            placeholder={viewMode === "files" ? "Search active files by name or path..." : "Search Recycle Bin by file name..."}
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

        {/* Active Files View */}
        {viewMode === "files" && (
          <>
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
                                  disabled={isBusy}
                                >
                                  {isBusy ? "Decrypting…" : "👁️ Preview"}
                                </button>
                              )}
                              <button
                                className="btn-primary btn-small"
                                onClick={() => handleDownload(f)}
                                disabled={isBusy}
                              >
                                {isBusy ? "Downloading…" : "⬇️ Download"}
                              </button>
                              <button className="btn-secondary btn-small" onClick={() => void handleShare(f)} disabled={isBusy} title="Create an expiring, read-only share link">🔗 Share</button>
                              <button
                                className="btn-secondary btn-small"
                                style={{ color: "#ef4444", borderColor: "rgba(239, 68, 68, 0.35)", padding: "5px 8px" }}
                                onClick={() => void handleDelete(f)}
                                disabled={isBusy}
                                title="Move to Android Recycle Bin"
                              >
                                🗑️
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
          </>
        )}

        {/* Recycle Bin View */}
        {viewMode === "trash" && (
          <div>
            {trashFiles.length === 0 ? (
              <div style={{ textAlign: "center", padding: "48px 0", color: "var(--text-muted)" }}>
                <div style={{ fontSize: "2.5rem", marginBottom: 10 }}>🗑️</div>
                <h4 style={{ color: "var(--text-main)", marginBottom: 4 }}>Android Recycle Bin is empty</h4>
                <p style={{ fontSize: "0.85rem" }}>Deleted files moved to the Android recycle bin will appear here for restoration or permanent purge.</p>
                <button
                  className="btn-secondary btn-small"
                  style={{ marginTop: 14 }}
                  onClick={() => setViewMode("files")}
                >
                  ← Back to Active Files
                </button>
              </div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table className="vault-table">
                  <thead>
                    <tr>
                      <th>File Name</th>
                      <th>Original Android Path</th>
                      <th>Size</th>
                      <th>Status</th>
                      <th style={{ textAlign: "right" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredTrashFiles.map((f) => {
                      const isBusy = busyFileId === f.id;

                      return (
                        <tr key={f.id}>
                          <td>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600 }}>
                              <span>{getFileIcon(f.name, f.mimeType)}</span>
                              <span style={{ color: "var(--text-main)" }}>{f.name}</span>
                            </div>
                          </td>
                          <td className="font-mono" style={{ fontSize: "0.78rem", color: "var(--text-muted)", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {f.path}
                          </td>
                          <td className="font-mono" style={{ fontSize: "0.82rem", color: "var(--text-sub)" }}>
                            {formatBytes(f.sizeBytes)}
                          </td>
                          <td>
                            <span className="badge-e2e" style={{ background: "rgba(239, 68, 68, 0.15)", color: "#ef4444" }}>
                              🗑️ Recycled
                            </span>
                          </td>
                          <td style={{ textAlign: "right" }}>
                            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                              <button
                                className="btn-primary btn-small"
                                onClick={() => void handleRestore(f)}
                                disabled={isBusy}
                                title="Restore file back to Android device"
                              >
                                {isBusy ? "Restoring…" : "🔄 Restore"}
                              </button>
                              <button
                                className="btn-secondary btn-small"
                                style={{ color: "#ef4444", borderColor: "rgba(239, 68, 68, 0.4)" }}
                                onClick={() => void handlePermanentDelete(f)}
                                disabled={isBusy}
                                title="Permanently delete from Android storage"
                              >
                                {isBusy ? "Purging…" : "❌ Delete Permanently"}
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
        )}
      </div>
        </div>
    </div>
  );
}
