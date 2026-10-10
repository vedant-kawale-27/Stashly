/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router-dom";
import { ApiError, BrokerClient, Device, FileMeta, TransferProgress } from "../api";
import { bytesToBase64, createDek, decryptFile, decryptChunkedFile, encryptFile, unwrapDek, wrapDek } from "../crypto";
import { getOfflineDownload, saveOfflineDownload } from "../offlineCache";
import { getCachedThumbnail, cacheThumbnail } from "../thumbCache";
import { subscribeRealtime } from "../realtime";

interface Props {
  client: BrokerClient;
  deviceId: string | null;
  onSelectDevice: (deviceId: string | null) => void;
  devices: Device[];
  masterKey: string;
  searchQuery?: string;
  onSearchQueryChange?: (value: string) => void;
  viewMode?: "grid" | "list";
  onViewModeChange?: (value: "grid" | "list") => void;
}

type TransferKind = "upload" | "download";
type StorageKind = "internal" | "sdcard";
interface TransferItem {
  id: string;
  name: string;
  kind: TransferKind;
  storage: StorageKind;
  progress: number;
  loaded: number;
  total: number | null;
  status: "active" | "complete" | "error";
  error?: string;
}

function storageKind(path: string): StorageKind {
  return path.replace(/^\/+/, "").startsWith("SD Card") ? "sdcard" : "internal";
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

function isImageFile(file: FileMeta): boolean {
  if (file.mimeType?.startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|svg|bmp|heic|avif)$/i.test(file.name);
}

function isDirectoryEntry(file: FileMeta): boolean {
  return file.mimeType === "inode/directory" || file.mimeType === "directory" || file.contentHash === "directory";
}

// In-memory cache of resolved thumbnail URLs (avoids re-fetching within same session)
const thumbUrlCache = new Map<string, string>();
const thumbUrlFetches = new Map<string, Promise<string | null>>();

// Queue to throttle concurrent thumbnail fetches
let activeThumbnailFetches = 0;
const MAX_CONCURRENT_THUMB_FETCHES = 4;
const thumbnailFetchQueue: (() => void)[] = [];

function acquireThumbSlot(): Promise<() => void> {
  return new Promise((resolve) => {
    const run = () => {
      activeThumbnailFetches++;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        activeThumbnailFetches--;
        const next = thumbnailFetchQueue.shift();
        if (next) next();
      });
    };

    if (activeThumbnailFetches < MAX_CONCURRENT_THUMB_FETCHES) {
      run();
    } else {
      thumbnailFetchQueue.push(run);
    }
  });
}

function thumbnailCacheKey(file: FileMeta): string {
  return `${file.id}:${file.contentHash}`;
}

async function loadThumbnailUrl(file: FileMeta, client: BrokerClient, masterKey: string): Promise<string | null> {
  if (!file.deviceOnline || !file.hasThumbnail || !masterKey.trim()) return null;
  const key = thumbnailCacheKey(file);
  const cached = thumbUrlCache.get(key);
  if (cached) return cached;

  // Check persistent IndexedDB cache first
  const idbCached = await getCachedThumbnail(file.id, file.contentHash).catch(() => null);
  if (idbCached) {
    thumbUrlCache.set(key, idbCached);
    return idbCached;
  }

  const inFlight = thumbUrlFetches.get(key);
  if (inFlight) return inFlight;

  const request = (async () => {
    const release = await acquireThumbSlot();
    try {
      const result = await client.downloadThumbnail(file.id);
      if (!result) return null;
      const dek = await unwrapDek(masterKey.trim(), result.wrappedDek);
      const plaintext = await decryptFile(dek, result.ciphertext);
      const url = await cacheThumbnail(file.id, file.contentHash, plaintext);
      thumbUrlCache.set(key, url);
      return url;
    } finally {
      release();
    }
  })()
    .catch(() => null)
    .finally(() => thumbUrlFetches.delete(key));

  thumbUrlFetches.set(key, request);
  return request;
}

function ThumbnailIcon({ file, client, masterKey }: { file: FileMeta; client: BrokerClient; masterKey: string }) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(() =>
    file.deviceOnline ? (thumbUrlCache.get(thumbnailCacheKey(file)) ?? null) : null
  );
  const containerRef = useRef<HTMLSpanElement | null>(null);
  const [isInProximity, setIsInProximity] = useState(false);

  useEffect(() => {
    if (thumbUrl || !file.deviceOnline || !file.hasThumbnail) return;

    const cached = thumbUrlCache.get(thumbnailCacheKey(file));
    if (cached) {
      setThumbUrl(cached);
      return;
    }

    const el = containerRef.current;
    if (!el || !("IntersectionObserver" in window)) {
      setIsInProximity(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setIsInProximity(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [file.id, file.contentHash, file.hasThumbnail, file.deviceOnline, thumbUrl]);

  useEffect(() => {
    if (!isInProximity || thumbUrl || !file.deviceOnline || !file.hasThumbnail || !masterKey.trim()) return;

    let cancelled = false;
    loadThumbnailUrl(file, client, masterKey).then((url) => {
      if (!cancelled && url) {
        setThumbUrl(url);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [isInProximity, file, client, masterKey, thumbUrl]);

  if (thumbUrl && file.deviceOnline) {
    return (
      <span ref={containerRef} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
        <img
          src={thumbUrl}
          alt=""
          className="file-thumbnail-preview"
          style={{
            width: 32,
            height: 32,
            objectFit: "cover",
            flexShrink: 0,
            borderRadius: 4,
          }}
        />
      </span>
    );
  }
  return <span ref={containerRef}>{getFileIcon(file.name, file.mimeType)}</span>;
}

function pathSegments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function isInsidePath(filePath: string, folderPath: string): boolean {
  const fileSegments = pathSegments(filePath);
  const folderSegments = pathSegments(folderPath);
  return folderSegments.every((segment, index) => fileSegments[index] === segment);
}

function buildRenamedPath(filePath: string, newName: string): string {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const slash = normalized.lastIndexOf("/");
  const parent = slash >= 0 ? normalized.slice(0, slash) : "";
  const joined = parent ? `${parent}/${newName}` : newName;
  return `/${joined}`;
}

type FileActionItem = {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
};

function FileActionMenu({
  open,
  onToggle,
  label,
  items,
  className,
  trigger = "⋮",
  triggerClassName = "btn-icon btn-small-icon file-item-menu-btn",
  align = "end",
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  items: FileActionItem[];
  className?: string;
  trigger?: React.ReactNode;
  triggerClassName?: string;
  align?: "start" | "end";
}) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);

  const updatePosition = useCallback(() => {
    const button = buttonRef.current;
    const popover = popoverRef.current;
    if (!button || !open) return;

    const rect = button.getBoundingClientRect();
    const menuWidth = popover?.offsetWidth ?? 180;
    const menuHeight = popover?.offsetHeight ?? 170;
    const gap = 6;
    const pad = 8;

    let top = rect.bottom + gap;
    if (top + menuHeight > window.innerHeight - pad) {
      top = Math.max(pad, rect.top - gap - menuHeight);
    }

    let left = align === "start" ? rect.left : rect.right - menuWidth;
    if (left < pad) left = pad;
    if (left + menuWidth > window.innerWidth - pad) {
      left = Math.max(pad, window.innerWidth - pad - menuWidth);
    }

    setCoords({ top, left });
  }, [open, align]);

  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    updatePosition();
  }, [open, updatePosition, items.length]);

  useEffect(() => {
    if (!open) return;
    const onReposition = () => updatePosition();
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      onToggle();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onToggle();
    };
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onToggle, updatePosition]);

  return (
    <div className={className ? `file-action-menu ${className}` : "file-action-menu"} onClick={(event) => event.stopPropagation()}>
      <button
        ref={buttonRef}
        className={triggerClassName}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        {trigger}
      </button>
      {open && createPortal(
        <div
          ref={popoverRef}
          className="file-action-popover file-action-popover-fixed"
          role="menu"
          style={coords ? { top: coords.top, left: coords.left } : { top: -9999, left: -9999, visibility: "hidden" }}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              className={item.danger ? "danger-button" : undefined}
              onClick={() => {
                if (item.disabled) return;
                item.onClick();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}

const PREVIEW_ZOOM_MIN = 0.25;
const PREVIEW_ZOOM_MAX = 4;
const PREVIEW_ZOOM_STEP = 0.25;

type PreviewState = { file: FileMeta; url: string | null; status: string; error: string | null };

function PreviewSidebarItem({
  file,
  active,
  client,
  masterKey,
  onSelect,
}: {
  file: FileMeta;
  active: boolean;
  client: BrokerClient;
  masterKey: string;
  onSelect: () => void;
}) {
  const rowRef = useRef<HTMLButtonElement | null>(null);
  const [thumbUrl, setThumbUrl] = useState<string | null>(() =>
    file.deviceOnline ? (thumbUrlCache.get(thumbnailCacheKey(file)) ?? null) : null
  );

  useEffect(() => {
    if (active) rowRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active]);

  useEffect(() => {
    if (thumbUrl || !file.deviceOnline || !file.hasThumbnail || !masterKey.trim()) return;
    const cached = thumbUrlCache.get(thumbnailCacheKey(file));
    if (cached) {
      setThumbUrl(cached);
      return;
    }
    let cancelled = false;
    loadThumbnailUrl(file, client, masterKey).then((url) => {
      if (!cancelled && url) setThumbUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [file, client, masterKey, thumbUrl]);

  return (
    <button
      ref={rowRef}
      type="button"
      className={`drive-preview-sidebar-item${active ? " active" : ""}`}
      onClick={onSelect}
    >
      <span className="drive-preview-sidebar-thumb">
        {thumbUrl ? (
          <img src={thumbUrl} alt="" />
        ) : (
          <span className="drive-preview-sidebar-thumb-fallback">{getFileIcon(file.name, file.mimeType)}</span>
        )}
      </span>
      <span className="drive-preview-sidebar-meta">
        <span className="drive-preview-sidebar-name">{file.name}</span>
        <span className="drive-preview-sidebar-size">{formatBytes(file.sizeBytes)}</span>
      </span>
    </button>
  );
}

function FilePreviewOverlay({
  preview,
  navFiles,
  sidebarFiles,
  breadcrumbSegments,
  onClose,
  onNavigate,
  onDownload,
  client,
  masterKey,
}: {
  preview: PreviewState;
  navFiles: FileMeta[];
  sidebarFiles: FileMeta[];
  breadcrumbSegments: string[];
  onClose: () => void;
  onNavigate: (file: FileMeta) => void;
  onDownload: (file: FileMeta) => void;
  client: BrokerClient;
  masterKey: string;
}) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const navIndex = navFiles.findIndex((f) => f.id === preview.file.id);
  const prevFile = navIndex > 0 ? navFiles[navIndex - 1] : null;
  const nextFile = navIndex >= 0 && navIndex < navFiles.length - 1 ? navFiles[navIndex + 1] : null;
  const isImage = isImageFile(preview.file);
  const isPdf = preview.file.mimeType === "application/pdf" || preview.file.name.toLowerCase().endsWith(".pdf");
  const zoomPercent = Math.round(zoom * 100);

  // Reset zoom & pan when switching files
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [preview.file.id]);

  // Reset pan when zoom returns to 1 (fit)
  useEffect(() => {
    if (zoom <= 1) setPan({ x: 0, y: 0 });
  }, [zoom]);

  // Pointer handlers for panning the zoomed image
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (zoom <= 1) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragStartRef.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
    setIsDragging(true);
  }, [zoom, pan]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragStartRef.current) return;
    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;
    setPan({ x: dragStartRef.current.panX + dx, y: dragStartRef.current.panY + dy });
  }, []);

  const handlePointerUp = useCallback(() => {
    dragStartRef.current = null;
    setIsDragging(false);
  }, []);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "ArrowLeft" && prevFile) {
        event.preventDefault();
        onNavigate(prevFile);
      }
      if (event.key === "ArrowRight" && nextFile) {
        event.preventDefault();
        onNavigate(nextFile);
      }
      if (isImage && preview.url) {
        if (event.key === "+" || event.key === "=") {
          event.preventDefault();
          setZoom((z) => Math.min(PREVIEW_ZOOM_MAX, +(z + PREVIEW_ZOOM_STEP).toFixed(2)));
        }
        if (event.key === "-") {
          event.preventDefault();
          setZoom((z) => Math.max(PREVIEW_ZOOM_MIN, +(z - PREVIEW_ZOOM_STEP).toFixed(2)));
        }
        if (event.key === "0") {
          event.preventDefault();
          setZoom(1);
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, onNavigate, prevFile, nextFile, isImage, preview.url]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !isImage || !preview.url) return;
    function onWheel(event: WheelEvent) {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const delta = event.deltaY > 0 ? -PREVIEW_ZOOM_STEP : PREVIEW_ZOOM_STEP;
      setZoom((z) => Math.min(PREVIEW_ZOOM_MAX, Math.max(PREVIEW_ZOOM_MIN, +(z + delta).toFixed(2))));
    }
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [isImage, preview.url, preview.file.id]);

  const breadcrumbPath = [...breadcrumbSegments, preview.file.name].join(" › ") || preview.file.name;

  return (
    <div className="drive-preview" role="dialog" aria-modal="true" aria-label={`Preview ${preview.file.name}`}>
      <header className="drive-preview-header">
        <button className="drive-preview-icon-btn" type="button" onClick={onClose} aria-label="Close preview">
          ×
        </button>
        <span className="drive-preview-file-icon" aria-hidden>{getFileIcon(preview.file.name, preview.file.mimeType)}</span>
        <div className="drive-preview-title-block">
          <h2 className="drive-preview-title">{preview.file.name}</h2>
          {(preview.error || preview.status !== "Ready") && (
            <p className={`drive-preview-subtitle${preview.error ? " error" : ""}`}>
              {preview.error ?? preview.status}
            </p>
          )}
        </div>
        {!isPdf && (
          <div className="drive-preview-header-actions">
            <button
              className="drive-preview-text-btn"
              type="button"
              onClick={() => onDownload(preview.file)}
            >
              Download
            </button>
          </div>
        )}
      </header>

      {/* PDF: full-bleed iframe with native toolbar, no custom controls */}
      {isPdf && (
        <div className="drive-preview-pdf-fullbleed">
          {preview.url ? (
            <iframe
              className="drive-preview-pdf"
              src={preview.url}
              title={preview.file.name}
            />
          ) : preview.error ? (
            <div className="drive-preview-loading error">{preview.error}</div>
          ) : (
            <div className="drive-preview-loading">
              <span className="drive-preview-spinner" aria-hidden />
              Loading preview…
            </div>
          )}
        </div>
      )}

      {/* Non-PDF: normal preview with tools, nav, sidebar, footer */}
      {!isPdf && (
        <>
          <div className="drive-preview-main">
            <div className="drive-preview-center">
              <div className="drive-preview-tools" aria-label="Preview tools">
                <button
                  className="drive-preview-icon-btn"
                  type="button"
                  title="Download"
                  aria-label="Download"
                  onClick={() => onDownload(preview.file)}
                >
                  ↓
                </button>
                {isImage && preview.url && (
                  <>
                    <span className="drive-preview-tools-divider" aria-hidden />
                    <button
                      className="drive-preview-icon-btn"
                      type="button"
                      title="Zoom out"
                      aria-label="Zoom out"
                      disabled={zoom <= PREVIEW_ZOOM_MIN}
                      onClick={() => setZoom((z) => Math.max(PREVIEW_ZOOM_MIN, +(z - PREVIEW_ZOOM_STEP).toFixed(2)))}
                    >
                      −
                    </button>
                    <span className="drive-preview-zoom-label">{zoomPercent}%</span>
                    <button
                      className="drive-preview-icon-btn"
                      type="button"
                      title="Zoom in"
                      aria-label="Zoom in"
                      disabled={zoom >= PREVIEW_ZOOM_MAX}
                      onClick={() => setZoom((z) => Math.min(PREVIEW_ZOOM_MAX, +(z + PREVIEW_ZOOM_STEP).toFixed(2)))}
                    >
                      +
                    </button>
                    <button
                      className="drive-preview-icon-btn drive-preview-reset-zoom"
                      type="button"
                      title="Reset zoom"
                      aria-label="Reset zoom"
                      onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}
                    >
                      Fit
                    </button>
                  </>
                )}
              </div>

              {prevFile && (
                <button
                  type="button"
                  className="drive-preview-nav drive-preview-nav-prev"
                  aria-label={`Previous: ${prevFile.name}`}
                  onClick={() => onNavigate(prevFile)}
                >
                  ‹
                </button>
              )}
              {nextFile && (
                <button
                  type="button"
                  className="drive-preview-nav drive-preview-nav-next"
                  aria-label={`Next: ${nextFile.name}`}
                  onClick={() => onNavigate(nextFile)}
                >
                  ›
                </button>
              )}

              <div className="drive-preview-stage" ref={stageRef}>
                {preview.url && isImage && (
                  <div
                    className="drive-preview-media-wrap"
                    style={{
                      transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                      cursor: zoom > 1 ? (isDragging ? "grabbing" : "grab") : "default",
                      transition: isDragging ? "none" : "transform 0.15s ease",
                      touchAction: "none",
                    }}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onPointerCancel={handlePointerUp}
                  >
                    <img className="drive-preview-media" src={preview.url} alt={preview.file.name} draggable={false} />
                  </div>
                )}
                {preview.url && preview.file.mimeType?.startsWith("video/") && (
                  <video className="drive-preview-media drive-preview-media-video" src={preview.url} controls autoPlay />
                )}
                {preview.url && preview.file.mimeType?.startsWith("audio/") && (
                  <audio className="drive-preview-audio" src={preview.url} controls autoPlay />
                )}
                {preview.url && !isImage &&
                  !preview.file.mimeType?.startsWith("video/") &&
                  !preview.file.mimeType?.startsWith("audio/") && (
                  <iframe className="drive-preview-frame" src={preview.url} title={preview.file.name} />
                )}
                {!preview.url && !preview.error && (
                  <div className="drive-preview-loading">
                    <span className="drive-preview-spinner" aria-hidden />
                    Loading preview…
                  </div>
                )}
                {!preview.url && preview.error && (
                  <div className="drive-preview-loading error">{preview.error}</div>
                )}
              </div>
            </div>

            {sidebarFiles.length > 1 && (
              <aside className="drive-preview-sidebar" aria-label="Files in this folder">
                {sidebarFiles.map((file) => (
                  <PreviewSidebarItem
                    key={file.id}
                    file={file}
                    active={file.id === preview.file.id}
                    client={client}
                    masterKey={masterKey}
                    onSelect={() => {
                      if (file.id !== preview.file.id) onNavigate(file);
                    }}
                  />
                ))}
              </aside>
            )}
          </div>

          <footer className="drive-preview-footer">
            <span className="drive-preview-breadcrumb">{breadcrumbPath}</span>
            {navFiles.length > 1 && navIndex >= 0 && (
              <span className="drive-preview-counter">
                {navIndex + 1} of {navFiles.length}
              </span>
            )}
          </footer>
        </>
      )}
    </div>
  );
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
    left.deviceSharingPaused === right.deviceSharingPaused &&
    left.sharingEnabled === right.sharingEnabled &&
    left.isCached === right.isCached &&
    left.cachedAt === right.cachedAt &&
    left.lastAccessAt === right.lastAccessAt &&
    left.deletedAt === right.deletedAt &&
    left.hasThumbnail === right.hasThumbnail &&
    left.encryptionFormat === right.encryptionFormat;
}

function reconcileFiles(previous: FileMeta[], next: FileMeta[]): FileMeta[] {
  const previousById = new Map(previous.map((file) => [file.id, file]));
  const reconciled = next.map((file) => {
    const existing = previousById.get(file.id);
    return existing && sameFileMeta(existing, file) ? existing : file;
  });
  if (reconciled.length === previous.length && reconciled.every((file, index) => file === previous[index])) {
    return previous;
  }
  return reconciled;
}

export function FileBrowser({ client, deviceId, onSelectDevice, devices, masterKey, searchQuery: controlledSearch, onSearchQueryChange, viewMode: controlledView, onViewModeChange }: Props) {
  const location = useLocation();
  const [viewMode, setViewMode] = useState<"files" | "trash">("files");
  const [fileViewMode, setFileViewMode] = useState<"grid" | "list">(controlledView ?? "grid");
  const [files, setFiles] = useState<FileMeta[]>(() => fileListViewCache.get(fileCacheKey(deviceId)) ?? []);
  const [trashFiles, setTrashFiles] = useState<FileMeta[]>(() => trashListViewCache.get(fileCacheKey(deviceId)) ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyFileId, setBusyFileId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [transfers, setTransfers] = useState<TransferItem[]>([]);
  const [transfersCollapsed, setTransfersCollapsed] = useState(false);
  const [minimizedTransfers, setMinimizedTransfers] = useState<Record<string, boolean>>({});
  const [currentPath, setCurrentPath] = useState("");
  const [uploadDestination, setUploadDestination] = useState("");
  const [localSearchQuery, setLocalSearchQuery] = useState("");
  const [preview, setPreview] = useState<{ file: FileMeta; url: string | null; status: string; error: string | null } | null>(null);
  const previewRequestRef = useRef(0);
  const refreshInFlightRef = useRef(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const folderUploadInputRef = useRef<HTMLInputElement>(null);
  const [sharingBlock, setSharingBlock] = useState<"paused" | "revoked" | null>(null);
  const [menuFileId, setMenuFileId] = useState<string | null>(null);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{
    file?: FileMeta;
    folder?: { path: string; name: string };
    newName: string;
    error?: string;
  } | null>(null);
  const [createFolderTarget, setCreateFolderTarget] = useState<{ name: string; error?: string } | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    message: string;
    icon: string;
    confirmText: string;
    confirmVariant: "danger" | "warning" | "primary";
    action: () => Promise<void> | void;
  } | null>(null);
  const searchQuery = controlledSearch ?? localSearchQuery;
  const fileView = controlledView ?? fileViewMode;
  const setSearchQuery = onSearchQueryChange ?? setLocalSearchQuery;
  const setFileView = onViewModeChange ?? setFileViewMode;

  const selectedDevice = devices.find((d) => d.id === deviceId);
  const hasSdCard = selectedDevice
    ? (selectedDevice.platform === "android" && selectedDevice.sdcardMounted === true)
    : devices.some((d) => d.platform === "android" && d.sdcardMounted === true);
  const isVaultRootWithSdCard = hasSdCard && currentPath === "";

  const updateTransfer = useCallback((id: string, patch: Partial<TransferItem>) => {
    setTransfers((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  }, []);

  function beginTransfer(name: string, kind: TransferKind, path: string, total: number | null): string {
    const id = `${kind}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setTransfers((current) => [...current, { id, name, kind, storage: storageKind(path), progress: 0, loaded: 0, total, status: "active" }]);
    return id;
  }

  function finishTransfer(id: string, error?: string) {
    updateTransfer(id, error ? { status: "error", error } : { status: "complete", progress: 100 });
    window.setTimeout(() => setTransfers((current) => current.filter((item) => item.id !== id)), error ? 5000 : 1800);
  }

  function transferProgress(id: string, progress: TransferProgress) {
    updateTransfer(id, {
      loaded: progress.loaded,
      total: progress.total,
      progress: progress.total ? Math.min(100, (progress.loaded / progress.total) * 100) : 0,
    });
  }
  useEffect(() => {
    if (location.search.includes("view=trash")) setViewMode("trash");
    else setViewMode("files");
  }, [location.search]);

  function clearDisplayedFiles(block: "paused" | "revoked") {
    setSharingBlock(block);
    setFiles([]);
    setTrashFiles([]);
    fileListViewCache.set(fileCacheKey(deviceId), []);
    trashListViewCache.set(fileCacheKey(deviceId), []);
    setError(block === "paused" ? "Sharing paused by the device owner." : "Your access was revoked.");
  }

  async function refresh(force = false, requestDeviceSync = false) {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    setLoading(true);
    try {
      if (requestDeviceSync && deviceId) {
        await client.syncDevice(deviceId).catch(() => undefined);
      }

      const [nextFiles, nextTrash] = await Promise.all([
        client.listFiles(deviceId ?? undefined, force, false),
        client.listTrash(deviceId ?? undefined, force).catch(() => []),
      ]);
      const currentFileState = nextFiles.find((file) => file.deviceId === deviceId);
      const paused = currentFileState?.deviceSharingPaused === true;
      const revoked = currentFileState?.sharingEnabled === false;
      if (paused || revoked) {
        clearDisplayedFiles(paused ? "paused" : "revoked");
        return;
      }
      setSharingBlock(null);

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
      refreshInFlightRef.current = false;
    }
  }

  useEffect(() => {
    setCurrentPath("");
    setUploadDestination("");
    setFiles(fileListViewCache.get(fileCacheKey(deviceId)) ?? []);
    setTrashFiles(trashListViewCache.get(fileCacheKey(deviceId)) ?? []);
    setSharingBlock(null);
    setError(null);
    void refresh(false);
    const interval = window.setInterval(() => {
      if (!document.hidden) void refresh(true);
    }, 15_000);
    const onVisibilityChange = () => {
      if (!document.hidden) void refresh(true);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [deviceId]);

  useEffect(() => subscribeRealtime((event) => {
    if (event.deviceId !== deviceId) return;
    if (event.type === "device_sharing_changed") {
      if (event.sharingPaused === true) {
        clearDisplayedFiles("paused");
      } else if (event.sharingEnabled === false) {
        clearDisplayedFiles("revoked");
      } else {
        setSharingBlock(null);
        void refresh(true);
      }
    }
  }), [deviceId]);

  useEffect(() => {
    setUploadDestination(currentPath);
  }, [currentPath]);

  async function fetchAndDecrypt(file: FileMeta, transferId?: string): Promise<Blob> {
    let downloaded;
    try {
      downloaded = await client.downloadFile(file.id, file.encryptionFormat, transferId ? (progress) => transferProgress(transferId, progress) : undefined);
      await saveOfflineDownload(file, downloaded.ciphertext, downloaded.wrappedDek).catch(() => undefined);
    } catch (networkError) {
      if (networkError instanceof ApiError && networkError.code === "SHARING_PAUSED") {
        throw new Error("Sharing is paused by the device owner.");
      }
      const cached = await getOfflineDownload(file.id);
      if (!cached) throw networkError;
      downloaded = { ciphertext: cached.ciphertext, wrappedDek: cached.wrappedDek, fromCache: true };
    }
    const { ciphertext, wrappedDek } = downloaded;
    const dek = await unwrapDek(masterKey.trim(), wrappedDek);
    const plaintext = file.encryptionFormat === "chunked"
      ? await decryptChunkedFile(dek, ciphertext)
      : await decryptFile(dek, ciphertext);
    return new Blob([plaintext], { type: file.mimeType ?? "application/octet-stream" });
  }

  async function fetchAndDecryptThumbnail(file: FileMeta): Promise<Blob> {
    const downloaded = await client.downloadThumbnail(file.id);
    if (!downloaded) {
      throw new Error("Preview thumbnail is unavailable while the Android node is offline.");
    }
    const dek = await unwrapDek(masterKey.trim(), downloaded.wrappedDek);
    const plaintext = await decryptFile(dek, downloaded.ciphertext);
    return new Blob([plaintext], { type: file.mimeType ?? "image/jpeg" });
  }

  function handleDelete(file: FileMeta) {
    const isFolder = isDirectoryEntry(file);
    setConfirmDialog({
      icon: "🗑️",
      title: "Move to Recycle Bin",
      message: isFolder
        ? `Move folder "${file.name}" and its contents to the Android Recycle Bin? You can restore it anytime.`
        : `Move "${file.name}" to the Android Recycle Bin? You can restore it anytime.`,
      confirmText: "Move to Trash",
      confirmVariant: "warning",
      action: async () => {
        setBusyFileId(file.id);
        setError(null);
        try {
          await client.deleteFile(file.id);
          const folderPrefix = getVirtualPath(file.path).replace(/^\/+/, "");
          setFiles((prev) => {
            const nextFiles = prev.filter((item) => {
              if (item.id === file.id) return false;
              if (!isFolder) return true;
              const itemPath = getVirtualPath(item.path).replace(/^\/+/, "");
              return itemPath !== folderPrefix && !itemPath.startsWith(`${folderPrefix}/`);
            });
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
    });
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

  function handlePermanentDelete(file: FileMeta) {
    setConfirmDialog({
      icon: "⚠️",
      title: "Permanently Delete File",
      message: `Permanently erase "${file.name}" from your Android phone? This action CANNOT be undone.`,
      confirmText: "Permanently Delete",
      confirmVariant: "danger",
      action: async () => {
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
    });
  }

  function handleEmptyTrash() {
    if (trashFiles.length === 0) return;
    setConfirmDialog({
      icon: "🧹",
      title: "Empty Android Recycle Bin",
      message: `Permanently delete all ${trashFiles.length} item(s) in the Android Recycle Bin? This action CANNOT be undone.`,
      confirmText: "Empty Recycle Bin",
      confirmVariant: "danger",
      action: async () => {
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
    });
  }

  function handleRename(file: FileMeta) {
    setRenameTarget({ file, newName: file.name });
  }

  async function submitRename() {
    if (!renameTarget) return;
    const { file, folder, newName } = renameTarget;
    const currentName = file ? file.name : (folder ? folder.name : "");
    const trimmed = newName.trim();
    if (!trimmed || trimmed === currentName) {
      setRenameTarget(null);
      return;
    }
    if (/[/\\]/.test(trimmed) || trimmed === "." || trimmed === "..") {
      setRenameTarget((prev) => prev ? { ...prev, error: "Enter a valid name without path separators." } : null);
      return;
    }

    setRenameTarget(null);

    if (folder) {
      setLoading(true);
      setError(null);
      try {
        const prefix = folder.path.replace(/^\/+/, "");
        const parentSegments = pathSegments(folder.path).slice(0, -1);
        const newVirtualFolder = [...parentSegments, trimmed].join("/");

        const contained = files.filter((f) => {
          const itemPath = getVirtualPath(f.path).replace(/^\/+/, "");
          return itemPath === prefix || itemPath.startsWith(`${prefix}/`);
        });

        if (file) {
          const destination = buildRenamedPath(file.path, trimmed);
          await client.moveFile(file.id, destination);
        }

        for (const f of contained) {
          if (file && f.id === file.id) continue;
          const vPath = getVirtualPath(f.path).replace(/^\/+/, "");
          const subSuffix = vPath.slice(prefix.length);
          let newVirtualPath = `${newVirtualFolder}${subSuffix}`;
          let newDevicePath = newVirtualPath;
          if (hasSdCard) {
            if (newDevicePath.startsWith("Internal Storage/")) {
              newDevicePath = newDevicePath.replace("Internal Storage/", "");
            } else if (newDevicePath === "Internal Storage") {
              newDevicePath = "";
            }
          }
          if (!newDevicePath.startsWith("/")) {
            newDevicePath = `/${newDevicePath}`;
          }
          await client.moveFile(f.id, newDevicePath);
        }

        setError(`Renamed folder "${folder.name}" to "${trimmed}".`);
        setTimeout(() => void refresh(true, true), 600);
      } catch (err: any) {
        setError(err.message ?? "Failed to rename folder");
      } finally {
        setLoading(false);
      }
      return;
    }

    if (!file) return;
    setBusyFileId(file.id);
    setError(null);
    try {
      const destination = buildRenamedPath(file.path, trimmed);
      await client.moveFile(file.id, destination);
      const isFolder = isDirectoryEntry(file);
      const oldPrefix = file.path.replace(/\/+$/, "");
      setFiles((prev) => {
        const nextFiles = prev.map((item) => {
          if (item.id === file.id) return { ...item, name: trimmed, path: destination };
          if (!isFolder) return item;
          if (item.path === oldPrefix || item.path.startsWith(`${oldPrefix}/`)) {
            return { ...item, path: `${destination}${item.path.slice(oldPrefix.length)}` };
          }
          return item;
        });
        fileListViewCache.set(fileCacheKey(deviceId), nextFiles);
        return nextFiles;
      });
      setPreview((current) => (current?.file.id === file.id
        ? { ...current, file: { ...current.file, name: trimmed, path: destination } }
        : current));
      setError(`Renamed to "${trimmed}".`);
      setTimeout(() => void refresh(true, true), 600);
    } catch (err: any) {
      setError(err.message ?? "Failed to rename");
    } finally {
      setBusyFileId(null);
    }
  }

  async function handleShare(file: FileMeta) {
    if (isDirectoryEntry(file) || !file.encryptedDek?.trim()) {
      setError("Share links are only available for files, not folders.");
      return;
    }
    if (!masterKey.trim()) {
      setError("Configure this device's master key before creating a share link.");
      return;
    }
    try {
      const dek = await unwrapDek(masterKey.trim(), file.encryptedDek);
      const share = await client.createShare(file.id, file.deviceId);
      const shareUrl = `${window.location.origin}/share/${encodeURIComponent(share.token)}#dek=${encodeURIComponent(bytesToBase64(dek))}`;
      await navigator.clipboard?.writeText(shareUrl);
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
    const transferId = beginTransfer(file.name, "download", file.path, file.sizeBytes);
    try {
      // For chunked files, try streaming download to avoid full buffering
      if (file.encryptionFormat === "chunked" && "showSaveFilePicker" in window) {
        try {
          const handle = await (window as any).showSaveFilePicker({ suggestedName: file.name });
          const writable = await handle.createWritable();
          let dek: Uint8Array | null = null;
          await client.streamDownloadChunked(file.id, async (encChunk, _index, wrappedDek) => {
            if (!dek) dek = await unwrapDek(masterKey.trim(), wrappedDek);
            const plaintext = await decryptFile(dek, encChunk.buffer as ArrayBuffer);
            await writable.write(new Uint8Array(plaintext));
          }, undefined, (progress) => transferProgress(transferId, { loaded: Math.min(file.sizeBytes, progress.loaded), total: file.sizeBytes }));
          await writable.close();
          finishTransfer(transferId);
          setBusyFileId(null);
          return;
        } catch (fsErr: any) {
          if (fsErr?.name === "AbortError") {
            setBusyFileId(null);
            return;
          }
          // Fall through to buffered download on other errors
        }
      }

      // Buffered download (legacy files, preview, or unsupported browser)
      const blob = await fetchAndDecrypt(file, transferId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      finishTransfer(transferId);
    } catch (err: any) {
      finishTransfer(transferId, err.message ?? "Download or decryption failed");
      setError(err.code === "DEVICE_OFFLINE_NO_CACHE" || err.code === "DEVICE_TIMEOUT_NO_CACHE"
        ? `${err.message}. Check that the phone is connected to the same broker URL as this web session.`
        : err.message ?? "Download or decryption failed");
    } finally {
      setBusyFileId(null);
    }
  }

  async function handleDownloadFolder(folderPath: string, folderName: string) {
    if (!masterKey.trim()) {
      setError("Open Devices, select this device, and configure its master key first.");
      return;
    }
    const prefix = folderPath.replace(/^\/+/, "");
    const contained = files.filter((f) => {
      if (isDirectoryEntry(f)) return false;
      const itemPath = getVirtualPath(f.path).replace(/^\/+/, "");
      return itemPath === prefix || itemPath.startsWith(`${prefix}/`);
    });
    if (contained.length === 0) {
      setError(`Folder "${folderName}" has no downloadable files.`);
      return;
    }
    setError(`Downloading ${contained.length} file${contained.length === 1 ? "" : "s"} from "${folderName}"…`);
    for (const file of contained) {
      await handleDownload(file);
    }
  }

  function handleRenameFolder(folderPath: string, folderName: string, entry?: FileMeta | null) {
    setRenameTarget({
      file: entry ?? undefined,
      folder: { path: folderPath, name: folderName },
      newName: folderName,
    });
  }

  function handleDeleteFolder(folderPath: string, folderName: string, entry?: FileMeta | null) {
    const prefix = folderPath.replace(/^\/+/, "");
    const contained = files.filter((f) => {
      const itemPath = getVirtualPath(f.path).replace(/^\/+/, "");
      return itemPath === prefix || itemPath.startsWith(`${prefix}/`);
    });
    setConfirmDialog({
      icon: "🗑️",
      title: "Move Folder to Recycle Bin",
      message: contained.length > 0
        ? `Move folder "${folderName}" and its ${contained.length} file(s) to the Android Recycle Bin?`
        : `Move folder "${folderName}" to the Android Recycle Bin?`,
      confirmText: "Move to Trash",
      confirmVariant: "warning",
      action: async () => {
        setLoading(true);
        setError(null);
        try {
          if (entry) {
            await client.deleteFile(entry.id);
          }
          for (const file of contained) {
            if (entry && file.id === entry.id) continue;
            await client.deleteFile(file.id);
          }
          setFiles((prev) => {
            const nextFiles = prev.filter((item) => {
              if (entry && item.id === entry.id) return false;
              const itemPath = getVirtualPath(item.path).replace(/^\/+/, "");
              return !(itemPath === prefix || itemPath.startsWith(`${prefix}/`));
            });
            fileListViewCache.set(fileCacheKey(deviceId), nextFiles);
            return nextFiles;
          });
          setError(`Moved folder "${folderName}" to Android Recycle Bin.`);
          setTimeout(() => void refresh(true, true), 600);
        } catch (err: any) {
          setError(err.message ?? "Failed to move folder to Recycle Bin");
        } finally {
          setLoading(false);
        }
      },
    });
  }

  async function handleShareFolder(folderPath: string, folderName: string, entry?: FileMeta | null) {
    if (!masterKey.trim()) {
      setError("Configure this device's master key before creating a share link.");
      return;
    }
    const prefix = folderPath.replace(/^\/+/, "");
    const targetFile = entry ?? files.find((f) => {
      const itemPath = getVirtualPath(f.path).replace(/^\/+/, "");
      return itemPath === prefix || itemPath.startsWith(`${prefix}/`);
    });
    if (!targetFile) {
      setError(`Folder "${folderName}" has no files to share.`);
      return;
    }
    await handleShare(targetFile);
  }

  async function handlePreview(file: FileMeta) {
    if (!masterKey.trim()) {
      setError("Open Devices, select this device, and configure its master key first.");
      return;
    }
    setBusyFileId(file.id);
    setError(null);

    // Open synchronously so the browser does not block the preview window while
    // the thumbnail and encrypted chunks are being fetched.
    const canProgressivelyPreview = isImageFile(file) &&
      file.encryptionFormat === "chunked" &&
      file.hasThumbnail &&
      file.deviceOnline;
    const requestId = ++previewRequestRef.current;
    setPreview({ file, url: null, status: "Loading preview...", error: null });
    if (canProgressivelyPreview) {
      let currentUrl: string | null = null;
      let thumbnailUrl: string | null = null;

      try {
        thumbnailUrl = URL.createObjectURL(await fetchAndDecryptThumbnail(file));
        currentUrl = thumbnailUrl;
        setPreview((current) => requestId === previewRequestRef.current && current?.file.id === file.id
          ? { ...current, url: thumbnailUrl, status: "Loading full resolution..." }
          : current);

        const plaintextParts: BlobPart[] = [];
        let dek: Uint8Array | null = null;
        const result = await client.streamDownloadChunked(file.id, async (encryptedChunk, _index, wrappedDek) => {
          if (!dek) dek = await unwrapDek(masterKey.trim(), wrappedDek);
          const plaintext = await decryptFile(dek, encryptedChunk.buffer as ArrayBuffer);
          plaintextParts.push(plaintext);
        });

        // Keep the Android thumbnail on screen while chunks arrive. Replacing
        // it with incomplete Blob URLs causes the preview to resize or flash.
        const fullResolutionUrl = URL.createObjectURL(new Blob(plaintextParts, {
          type: file.mimeType ?? "image/jpeg",
        }));
        currentUrl = fullResolutionUrl;
        setPreview((current) => requestId === previewRequestRef.current && current?.file.id === file.id
          ? { ...current, url: fullResolutionUrl, status: `Full resolution (${result.chunkCount} chunks)` }
          : current);
        window.setTimeout(() => {
          if (thumbnailUrl) URL.revokeObjectURL(thumbnailUrl);
          if (currentUrl && currentUrl !== thumbnailUrl) URL.revokeObjectURL(currentUrl);
        }, 10 * 60 * 1000);
      } catch (err: any) {
        setPreview((current) => requestId === previewRequestRef.current && current?.file.id === file.id
          ? { ...current, status: "Preview failed", error: err.message ?? "Preview failed" }
          : current);
      } finally {
        setBusyFileId(null);
      }
      return;
    }

    try {
      const blob = await fetchAndDecrypt(file);
      const url = URL.createObjectURL(blob);
      setPreview({ file, url, status: "Ready", error: null });
    } catch (err: any) {
      setPreview({ file, url: null, status: "Preview failed", error: err.message ?? "Decryption preview failed" });
      setError(err.code === "DEVICE_OFFLINE_NO_CACHE" || err.code === "DEVICE_TIMEOUT_NO_CACHE"
        ? `${err.message}. Check that the phone is connected to the same broker URL as this web session.`
        : err.message ?? "Decryption preview failed — verify Master Key.");
    } finally {
      setBusyFileId(null);
    }
  }

  function closePreview() {
    previewRequestRef.current += 1;
    if (preview?.url) URL.revokeObjectURL(preview.url);
    setPreview(null);
  }

  function assertCanUpload(): boolean {
    if (!deviceId) return false;
    if (isVaultRootWithSdCard) {
      setError("Please open either 'Internal Storage' or 'SD Card' before uploading.");
      return false;
    }
    if (!masterKey.trim()) {
      setError("Open Devices, select this device, and configure its master key first.");
      return false;
    }
    return true;
  }

  async function uploadOneFile(selected: File, destination: string) {
    if (selected.size > 30 * 1024 * 1024) {
      throw new Error(`"${selected.name}" exceeds the 30 MB upload limit.`);
    }
    const transferId = beginTransfer(selected.name, "upload", destination || "/", selected.size);
    try {
      const plaintext = await selected.arrayBuffer();
      if (selected.size >= 1024 * 1024) {
        const dek = createDek();
        const encryptedDek = await wrapDek(masterKey.trim(), dek);
        await client.uploadChunkedFile(deviceId!, destination, selected.name, selected.type || null, plaintext, dek, encryptedDek, (progress) => transferProgress(transferId, progress));
      } else {
        const { ciphertext, dek } = await encryptFile(plaintext);
        const encryptedDek = await wrapDek(masterKey.trim(), dek);
        await client.uploadFile(deviceId!, destination, selected.name, selected.type || null, ciphertext, encryptedDek, (progress) => transferProgress(transferId, progress));
      }
      finishTransfer(transferId);
    } catch (err: any) {
      finishTransfer(transferId, err.message ?? "Upload failed");
      throw err;
    }
  }

  async function handleUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const list = event.target.files;
    event.target.value = "";
    if (!list?.length || !assertCanUpload()) return;

    const baseDestination = uploadDestination.trim() || "/";
    const selectedFiles = Array.from(list);
    const isFolderUpload = selectedFiles.some((file) => Boolean(file.webkitRelativePath));

    setUploading(true);
    setError(null);
    let uploaded = 0;
    try {
      for (const selected of selectedFiles) {
        let destination = baseDestination;
        if (isFolderUpload && selected.webkitRelativePath) {
          const parts = selected.webkitRelativePath.split("/").filter(Boolean);
          parts.pop();
          const nested = parts.join("/");
          destination = [baseDestination.replace(/^\/+|\/+$/g, ""), nested].filter(Boolean).join("/") || "/";
        }
        await uploadOneFile(selected, destination);
        uploaded += 1;
      }
      setError(
        isFolderUpload
          ? `Uploaded ${uploaded} file${uploaded === 1 ? "" : "s"} from folder to ${baseDestination === "/" ? "the device root" : baseDestination}.`
          : `Uploaded ${selectedFiles[0].name} to ${baseDestination === "/" ? "the device root" : baseDestination}.`
      );
      window.setTimeout(() => void refresh(true), 800);
    } catch (err: any) {
      setError(err.message ?? "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function openCreateFolder() {
    if (!assertCanUpload()) return;
    setCreateFolderTarget({ name: "" });
  }

  async function submitCreateFolder() {
    if (!createFolderTarget || !deviceId) return;
    const trimmed = createFolderTarget.name.trim();
    if (!trimmed) {
      setCreateFolderTarget((prev) => prev ? { ...prev, error: "Enter a folder name." } : null);
      return;
    }
    if (/[/\\]/.test(trimmed) || trimmed === "." || trimmed === "..") {
      setCreateFolderTarget((prev) => prev ? { ...prev, error: "Enter a valid folder name without path separators." } : null);
      return;
    }

    const base = uploadDestination.trim().replace(/^\/+|\/+$/g, "");
    const folderPath = `/${[base, trimmed].filter(Boolean).join("/")}`;
    setCreateFolderTarget(null);
    setError(null);
    try {
      await client.createFolder(deviceId, folderPath);
      setError(`Created folder "${trimmed}".`);
      window.setTimeout(() => void refresh(true, true), 600);
    } catch (err: any) {
      setError(err.message ?? "Failed to create folder");
    }
  }

  const [displayLimit, setDisplayLimit] = useState(80);

  useEffect(() => {
    setDisplayLimit(80);
  }, [currentPath, searchQuery, deviceId]);

  const isDirectoryItem = isDirectoryEntry;

  function getVirtualPath(path: string): string {
    const clean = path.replace(/^\/+/, "");
    if (!hasSdCard) return clean;
    if (clean.startsWith("SD Card/") || clean === "SD Card") return clean;
    if (clean.startsWith("Internal Storage/") || clean === "Internal Storage") return clean;
    return `Internal Storage/${clean}`;
  }

  const currentSegments = pathSegments(currentPath);

  // Active files hierarchy computation (memoized for fast rendering with 20k+ files)
  const { visibleFolders, displayFileList, actualFileCount } = React.useMemo(() => {
    const filtered = searchQuery.trim()
      ? files.filter((f) => f.name.toLowerCase().includes(searchQuery.toLowerCase()) || f.path.toLowerCase().includes(searchQuery.toLowerCase()))
      : null;

    type FolderRow = { path: string; name: string; entry: FileMeta | null; isSystem: boolean };
    const folderMap = new Map<string, FolderRow>();
    const visible: FileMeta[] = [];

    function upsertFolder(folderPath: string, folderName: string, entry: FileMeta | null, isSystem = false) {
      const existing = folderMap.get(folderPath);
      if (!existing) {
        folderMap.set(folderPath, { path: folderPath, name: folderName, entry, isSystem });
        return;
      }
      if (!existing.entry && entry) existing.entry = entry;
    }

    if (!filtered) {
      if (hasSdCard && currentPath === "") {
        const hasInternal = files.some((f) => f.path.startsWith("/Internal Storage") || f.path.startsWith("Internal Storage"));
        if (hasInternal) {
          upsertFolder("Internal Storage", "Internal Storage", null, true);
        }
        upsertFolder("SD Card", "SD Card", null, true);
      }

      for (const file of files) {
        const vPath = getVirtualPath(file.path);
        if (!isInsidePath(vPath, currentPath)) continue;
        const segments = pathSegments(vPath);
        if (segments.length <= currentSegments.length) continue;

        const remainingSegments = segments.slice(currentSegments.length);
        if (remainingSegments.length === 1) {
          if (isDirectoryItem(file)) {
            const folderName = remainingSegments[0];
            const folderPath = [...currentSegments, folderName].join("/");
            upsertFolder(folderPath, folderName, file);
          } else {
            visible.push(file);
          }
        } else {
          const folderName = remainingSegments[0];
          const folderPath = [...currentSegments, folderName].join("/");
          upsertFolder(folderPath, folderName, null);
        }
      }

      // Attach directory FileMeta entries that may have been inferred only from nested files.
      for (const file of files) {
        if (!isDirectoryItem(file)) continue;
        const vPath = getVirtualPath(file.path);
        const row = folderMap.get(vPath);
        if (row && !row.entry) row.entry = file;
      }
    }

    const folders = [...folderMap.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (!filtered) {
      visible.sort((a, b) => a.name.localeCompare(b.name));
    }

    const list = filtered
      ? filtered.filter((f) => !isDirectoryItem(f))
      : visible;

    const totalCount = files.filter((f) => !isDirectoryItem(f)).length;
    return { visibleFolders: folders, displayFileList: list, actualFileCount: totalCount };
  }, [files, currentPath, searchQuery, hasSdCard]);

  // Trashed files filtering (memoized)
  const filteredTrashFiles = React.useMemo(() => {
    return searchQuery.trim()
      ? trashFiles.filter((f) => f.name.toLowerCase().includes(searchQuery.toLowerCase()) || f.path.toLowerCase().includes(searchQuery.toLowerCase()))
      : trashFiles;
  }, [trashFiles, searchQuery]);

  const previewNavFiles = React.useMemo(
    () => displayFileList
      .filter((f) => isPreviewable(f.name, f.mimeType))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [displayFileList]
  );

  const previewSidebarFiles = React.useMemo(
    () => displayFileList.filter((f) => !isDirectoryEntry(f)),
    [displayFileList]
  );

  return (
    <div className="panel-box">
      {preview && (
        <FilePreviewOverlay
          preview={preview}
          navFiles={previewNavFiles}
          sidebarFiles={previewSidebarFiles}
          breadcrumbSegments={currentSegments.length ? ["Vault Root", ...currentSegments] : ["Vault Root"]}
          onClose={closePreview}
          onNavigate={(file) => { void handlePreview(file); }}
          onDownload={(file) => { void handleDownload(file); }}
          client={client}
          masterKey={masterKey}
        />
      )}
      <div className={`panel-box-header${viewMode === "files" ? " file-browser-header" : ""}`}>
        <div className="file-browser-header-left">
          <h3 className="panel-box-title">
            {viewMode === "files" ? "Your files" : "Android Recycle Bin"}
          </h3>
          <span className="btn-pill-cyan" style={{ padding: "2px 10px", fontSize: "0.75rem" }}>
            {viewMode === "files" ? `${actualFileCount} ${actualFileCount === 1 ? "File" : "Files"}` : `${trashFiles.length} Trashed`}
          </span>

          {viewMode === "files" && (
            <div className="file-view-toggle" role="group" aria-label="File view">
              <button type="button" className={fileView === "grid" ? "active" : ""} onClick={() => setFileView("grid")} title="Grid view">▦</button>
              <button type="button" className={fileView === "list" ? "active" : ""} onClick={() => setFileView("list")} title="List view">☷</button>
            </div>
          )}
        </div>

        {viewMode === "files" && (
          <div className="file-browser-header-center">
            <label className="file-search-box">
              <span>⌕</span>
              <input aria-label="Search files" placeholder="Search this device" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} />
            </label>
          </div>
        )}

        <div className="file-browser-header-right">
          {viewMode === "files" ? (
            <>
              <input
                ref={uploadInputRef}
                type="file"
                hidden
                disabled={isVaultRootWithSdCard}
                onChange={(event) => void handleUpload(event)}
              />
              <input
                ref={folderUploadInputRef}
                type="file"
                hidden
                multiple
                disabled={isVaultRootWithSdCard}
                onChange={(event) => void handleUpload(event)}
                {...({ webkitdirectory: "", directory: "" } as React.InputHTMLAttributes<HTMLInputElement>)}
              />
              <div className="file-upload-destination-row">
                <input
                  className="file-upload-destination-input"
                  aria-label="Android upload destination"
                  value={isVaultRootWithSdCard ? "" : (uploadDestination ? `/${uploadDestination.replace(/^\/+/, "")}` : "/")}
                  onChange={(event) => setUploadDestination(event.target.value.replace(/^\/+/, ""))}
                  placeholder={isVaultRootWithSdCard ? "Select Internal or SD Card..." : "/Android folder"}
                  disabled={isVaultRootWithSdCard}
                  title={isVaultRootWithSdCard ? "Upload disabled at Vault Root. Open 'Internal Storage' or 'SD Card' first." : undefined}
                />
                <FileActionMenu
                  open={newMenuOpen}
                  onToggle={() => {
                    if ((!deviceId || uploading || isVaultRootWithSdCard) && !newMenuOpen) return;
                    setNewMenuOpen((open) => !open);
                  }}
                  label="New"
                  align="end"
                  trigger={uploading ? "…" : "+"}
                  triggerClassName={`btn-primary file-new-btn${(!deviceId || uploading || isVaultRootWithSdCard) ? " is-disabled" : ""}`}
                  items={[
                    {
                      label: "Upload file",
                      disabled: !deviceId || uploading || isVaultRootWithSdCard,
                      onClick: () => {
                        setNewMenuOpen(false);
                        if (!assertCanUpload()) return;
                        uploadInputRef.current?.click();
                      },
                    },
                    {
                      label: "Upload folder",
                      disabled: !deviceId || uploading || isVaultRootWithSdCard,
                      onClick: () => {
                        setNewMenuOpen(false);
                        if (!assertCanUpload()) return;
                        folderUploadInputRef.current?.click();
                      },
                    },
                    {
                      label: "Create folder",
                      disabled: !deviceId || uploading || isVaultRootWithSdCard,
                      onClick: () => {
                        setNewMenuOpen(false);
                        openCreateFolder();
                      },
                    },
                  ]}
                />
              </div>
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
                    onClick={() => {
                      setViewMode("files");
                      onSelectDevice(device.id);
                    }}
                    type="button"
                  >
                    <span className="file-device-item-top">
                      <span className="file-device-icon">{device.platform === "windows" ? "💻" : "📱"}</span>
                      <span className="file-device-name" title={device.name}>{device.name}</span>
                      <span
                        className={`file-device-status${device.status === "online" ? " online" : ""}`}
                        title={device.sharingPaused ? "Sharing paused by owner" : device.status === "online" ? "Live Stream" : "Offline"}
                      />
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
                    {device.platform === "android" && device.sdcardMounted === true && device.sdcardTotalMb != null && device.sdcardTotalMb > 0 && (
                      <span className="file-device-storage file-device-storage-sdcard">
                        <span className="file-device-storage-track">
                          <span
                            className="file-device-storage-fill file-device-storage-fill-sdcard"
                            style={{
                              width: `${Math.min(100, Math.max(0, (((device.sdcardTotalMb - (device.sdcardFreeMb ?? 0)) / device.sdcardTotalMb) * 100)))}%`
                            }}
                          />
                        </span>
                        <span className="file-device-storage-label">
                          SD: {formatStorageMb(Math.max(0, device.sdcardTotalMb - (device.sdcardFreeMb ?? 0)))} used
                        </span>
                        <span className="file-device-storage-total">of {formatStorageMb(device.sdcardTotalMb)}</span>
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          <button
            className={`file-device-all-button${viewMode === "files" && !deviceId ? " selected" : ""}`}
            type="button"
            onClick={() => {
              setViewMode("files");
              onSelectDevice(null);
            }}
          >
            <span>▣</span>
            All linked devices
          </button>
          <button
            className={`file-device-all-button${viewMode === "trash" ? " selected" : ""}`}
            type="button"
            onClick={() => setViewMode("trash")}
          >
            <span>🗑️</span>
            Recycle Bin
            {trashFiles.length > 0 && <strong style={{ marginLeft: "auto" }}>{trashFiles.length}</strong>}
          </button>
          {viewMode === "trash" && (
            <button
              className="file-device-all-button"
              type="button"
              onClick={() => setViewMode("files")}
            >
              <span>📁</span>
              Active Files
            </button>
          )}
        </aside>

        <div className="panel-box-body file-browser-main">
        {error && <div className="ui-alert-error">{error}</div>}

        {/* Active Files View */}
        {viewMode === "files" && (
          <>
            {!searchQuery && (
              <div className="file-breadcrumbs">
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

            {sharingBlock ? (
              <div className="ui-empty-state">
                <div className="ui-empty-state-icon">🔒</div>
                <h4>
                  {sharingBlock === "paused" ? "Sharing paused by the device owner" : "Your access was revoked"}
                </h4>
                <p>
                  {sharingBlock === "paused"
                    ? "This device owner must start sharing again before its files become available."
                    : "The device owner must re-enable sharing for your account before its files become available."}
                </p>
              </div>
            ) : loading && files.length === 0 ? (
              <div className="ui-loading-state">
                Scanning encrypted vault files…
              </div>
            ) : files.length === 0 ? (
              <div className="ui-empty-state">
                <div className="ui-empty-state-icon">📁</div>
                <h4>No files synced yet</h4>
                <p>Files indexed on your connected phone will appear here.</p>
              </div>
            ) : (
              <div className={`file-manager-items ${fileView}`}>
                {fileView === "list" && (
                  <div className="file-list-header" role="row">
                    <span className="file-list-col-icon" aria-hidden />
                    <span className="file-list-col-name">Name</span>
                    <span className="file-list-col-size">Size / kind</span>
                    <span className="file-list-col-status">Status</span>
                    <span className="file-list-col-menu" aria-hidden />
                  </div>
                )}
                {!searchQuery && visibleFolders.map((folder) => {
                  const { path, name, entry } = folder;
                  const isInternalFolder = name === "Internal Storage" && currentPath === "";
                  const isSdCardFolder = name === "SD Card" && currentPath === "";
                  const isHardwareRoot = (name === "Internal Storage" || name === "SD Card") && currentPath === "";
                  const folderIcon = isInternalFolder ? "📱" : isSdCardFolder ? "💾" : "📁";
                  const folderMeta = isInternalFolder ? "Phone Internal Storage" : isSdCardFolder ? "Removable SD Card" : "Folder";
                  const menuKey = entry ? entry.id : `folder:${path}`;
                  const menuOpen = menuFileId === menuKey;
                  const isBusy = entry ? busyFileId === entry.id : false;
                  return (
                    <article
                      key={path}
                      className={`file-folder-card${isSdCardFolder ? " sdcard-folder-card" : ""}`}
                    >
                      <button
                        type="button"
                        className="file-folder-open"
                        onClick={() => setCurrentPath(path)}
                      >
                        <span className="file-card-icon">{folderIcon}</span>
                        <span className="file-card-name">{name}</span>
                        <span className="file-card-meta">{folderMeta}</span>
                      </button>
                      <FileActionMenu
                        className="file-folder-menu"
                        open={menuOpen}
                        onToggle={() => setMenuFileId(menuOpen ? null : menuKey)}
                        label={`Actions for ${name}`}
                        items={[
                          {
                            label: "Download",
                            disabled: isBusy,
                            onClick: () => {
                              setMenuFileId(null);
                              void handleDownloadFolder(path, name);
                            },
                          },
                          ...(!isHardwareRoot ? [
                            {
                              label: "Rename",
                              disabled: isBusy,
                              onClick: () => {
                                setMenuFileId(null);
                                handleRenameFolder(path, name, entry);
                              },
                            },
                          ] : []),
                          {
                            label: "Create share link",
                            disabled: isBusy,
                            onClick: () => {
                              setMenuFileId(null);
                              void handleShareFolder(path, name, entry);
                            },
                          },
                          ...(!isHardwareRoot ? [
                            {
                              label: "Move to Recycle Bin",
                              disabled: isBusy,
                              danger: true,
                              onClick: () => {
                                setMenuFileId(null);
                                handleDeleteFolder(path, name, entry);
                              },
                            },
                          ] : []),
                        ]}
                      />
                    </article>
                  );
                })}
                {!searchQuery && visibleFolders.length === 0 && displayFileList.length === 0 && (
                  <div className="file-folder-empty"><span>📂</span><strong>This folder is empty</strong><small>No files or subdirectories found inside {currentPath ? `/${currentPath}` : "this folder"}.</small></div>
                )}
                {displayFileList.slice(0, displayLimit).map((f) => {
                  const canPreview = isPreviewable(f.name, f.mimeType);
                  const isBusy = busyFileId === f.id;
                  return (
                    <article
                      key={f.id}
                      className={`file-item-card${canPreview ? " file-item-previewable" : ""}`}
                      title={canPreview ? "Double-click to preview" : undefined}
                      onDoubleClick={() => {
                        if (canPreview && !isBusy) void handlePreview(f);
                      }}
                    >
                      <div className="file-item-main">
                        <div className="file-item-icon"><ThumbnailIcon file={f} client={client} masterKey={masterKey} /></div>
                        <div className="file-item-copy">
                          <strong title={f.name}>{f.name}</strong>
                          <span title={f.path}>{f.path}</span>
                        </div>
                      </div>
                      <div className="file-item-details">
                        <span className="file-item-size">{formatBytes(f.sizeBytes)}</span>
                        <span className="file-item-status-row">
                          <span className="file-item-status">
                            {isBusy ? "Working…" : f.deviceOnline ? "● Live" : f.isCached ? "💾 Cached" : "Offline"}
                          </span>
                          <FileActionMenu
                            open={menuFileId === f.id}
                            onToggle={() => setMenuFileId(menuFileId === f.id ? null : f.id)}
                            label={`Actions for ${f.name}`}
                            items={[
                              {
                                label: "Download",
                                disabled: isBusy,
                                onClick: () => {
                                  setMenuFileId(null);
                                  void handleDownload(f);
                                },
                              },
                              {
                                label: "Rename",
                                disabled: isBusy,
                                onClick: () => {
                                  setMenuFileId(null);
                                  handleRename(f);
                                },
                              },
                              {
                                label: "Create share link",
                                onClick: () => {
                                  setMenuFileId(null);
                                  void handleShare(f);
                                },
                              },
                              {
                                label: "Move to Recycle Bin",
                                danger: true,
                                onClick: () => {
                                  setMenuFileId(null);
                                  handleDelete(f);
                                },
                              },
                            ]}
                          />
                        </span>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
            {displayFileList.length > displayLimit && (
              <div style={{ textAlign: "center", padding: "16px 0" }}>
                <button
                  type="button"
                  className="btn-secondary btn-small"
                  onClick={() => setDisplayLimit((prev) => prev + 80)}
                  style={{ minWidth: 200 }}
                >
                  Show More Files ({Math.min(displayLimit, displayFileList.length)} of {displayFileList.length})
                </button>
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
              <div className={`file-manager-items ${fileView}`}>
                {fileView === "list" && (
                  <div className="file-list-header file-list-header-trash" role="row">
                    <span className="file-list-col-icon" aria-hidden />
                    <span className="file-list-col-name">Name</span>
                    <span className="file-list-col-size">Size</span>
                    <span className="file-list-col-status">Status</span>
                    <span className="file-list-col-actions">Actions</span>
                  </div>
                )}
                {filteredTrashFiles.map((f) => {
                  const isBusy = busyFileId === f.id;
                  return (
                    <article key={f.id} className="file-item-card file-item-card-trash">
                      <div className="file-item-main">
                        <div className="file-item-icon">{getFileIcon(f.name, f.mimeType)}</div>
                        <div className="file-item-copy"><strong title={f.name}>{f.name}</strong><span title={f.path}>{f.path}</span></div>
                      </div>
                      <div className="file-item-details">
                        <span className="file-item-size">{formatBytes(f.sizeBytes)}</span>
                        <span className="file-item-status">🗑️ Recycled</span>
                      </div>
                      <div className="file-item-actions">
                        <button className="btn-primary btn-small" type="button" onClick={() => void handleRestore(f)} disabled={isBusy}>{isBusy ? "Restoring…" : "Restore"}</button>
                        <button className="btn-secondary btn-small danger-button" type="button" onClick={() => void handlePermanentDelete(f)} disabled={isBusy}>{isBusy ? "Purging…" : "Delete"}</button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>

      {/* Floating Transfer Stack Widget */}
      {transfers.length > 0 && (
        <aside className="transfer-floating-stack" aria-live="polite" aria-label="Transfer queue">
          <div className="transfer-stack-header">
            <div className="transfer-stack-title">
              <span className="transfer-stack-pulse" />
              <span>Transfers ({transfers.filter((t) => t.status === "active").length} active)</span>
            </div>
            <button
              type="button"
              className="transfer-toggle-btn"
              onClick={() => setTransfersCollapsed((prev) => !prev)}
              title={transfersCollapsed ? "Expand transfer drawer" : "Minimize transfer drawer"}
            >
              {transfersCollapsed ? "▲" : "▼"}
            </button>
          </div>

          {!transfersCollapsed && (
            <div className="transfer-stack-list">
              {[...transfers]
                .sort((a, b) => (a.kind === "upload" && b.kind === "download" ? -1 : 1))
                .map((item) => {
                  const isMinimized = minimizedTransfers[item.id] ?? false;
                  const isSdCard = item.storage === "sdcard";
                  const isUpload = item.kind === "upload";

                  return (
                    <div
                      key={item.id}
                      className={`transfer-card transfer-card-${item.kind} transfer-card-${item.storage} transfer-status-${item.status}${isMinimized ? " minimized" : ""}`}
                    >
                      <div className="transfer-card-header">
                        <div className="transfer-card-meta">
                          <span className={`transfer-badge transfer-badge-${item.kind}`}>
                            {isUpload ? "⬆ Upload" : "⬇ Download"}
                          </span>
                          <span className={`transfer-badge-storage ${isSdCard ? "sdcard" : "internal"}`}>
                            {isSdCard ? "💾 SD Card" : "📱 Internal"}
                          </span>
                        </div>
                        <div className="transfer-card-actions">
                          <button
                            type="button"
                            className="transfer-toggle-btn"
                            onClick={() => setMinimizedTransfers((prev) => ({ ...prev, [item.id]: !isMinimized }))}
                            title={isMinimized ? "Expand card" : "Minimize card"}
                          >
                            {isMinimized ? "➕" : "➖"}
                          </button>
                          {item.status !== "active" && (
                            <button
                              type="button"
                              className="transfer-close-btn"
                              onClick={() => setTransfers((prev) => prev.filter((t) => t.id !== item.id))}
                              title="Dismiss"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      </div>

                      <div className="transfer-card-body">
                        <div className="transfer-card-info">
                          <span className="transfer-file-name" title={item.name}>{item.name}</span>
                          <span className="transfer-file-progress-num">
                            {item.status === "error"
                              ? "Failed"
                              : item.status === "complete"
                              ? "Done"
                              : `${Math.round(item.progress)}%`}
                          </span>
                        </div>

                        <div className="transfer-progress-track">
                          <div
                            className={`transfer-progress-fill ${isSdCard ? "fill-sdcard" : "fill-internal"} ${item.status === "complete" ? "fill-complete" : item.status === "error" ? "fill-error" : ""}`}
                            style={{ width: `${Math.max(3, item.progress)}%` }}
                          />
                        </div>

                        {!isMinimized && (
                          <div className="transfer-card-details">
                            <span>{formatBytes(item.loaded)} {item.total ? `of ${formatBytes(item.total)}` : ""}</span>
                            <span className="transfer-status-text">
                              {item.status === "error"
                                ? (item.error ?? "Transfer failed")
                                : item.status === "complete"
                                ? "100% (Completed)"
                                : isUpload ? "Encrypting & Uploading…" : "Streaming & Decrypting…"}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
            </div>
          )}
        </aside>
      )}

      {/* Custom Rename Modal */}
      {renameTarget && (
        <div className="modal-overlay-bg" onClick={() => setRenameTarget(null)}>
          <div className="modal-dialog-box" style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => setRenameTarget(null)}
              style={{ position: "absolute", top: 16, right: 16, background: "none", border: "none", fontSize: "1.2rem", cursor: "pointer", color: "var(--text-muted)" }}
              aria-label="Close"
            >
              ✕
            </button>

            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
              <div style={{ width: 44, height: 44, borderRadius: "50%", background: "var(--bg-card-subtle)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1.3rem" }}>
                ✏️
              </div>
              <div>
                <h3 style={{ margin: 0, fontSize: "1.15rem", fontWeight: 700 }}>
                  Rename {renameTarget.folder ? "Folder" : "Item"}
                </h3>
                <p style={{ margin: "2px 0 0", fontSize: "0.82rem", color: "var(--text-muted)", wordBreak: "break-all" }}>
                  {renameTarget.file?.name ?? renameTarget.folder?.name ?? ""}
                </p>
              </div>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submitRename();
              }}
            >
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, color: "var(--text-muted)", marginBottom: 6 }}>
                  NEW NAME
                </label>
                <input
                  type="text"
                  autoFocus
                  className="auth-input"
                  style={{ width: "100%", padding: "10px 12px", borderRadius: "var(--radius-md)", border: "1px solid var(--border-accent)", background: "var(--bg-card-subtle)", color: "inherit", fontSize: "0.95rem" }}
                  value={renameTarget.newName}
                  onChange={(e) => setRenameTarget((prev) => prev ? { ...prev, newName: e.target.value, error: undefined } : null)}
                  onFocus={(e) => {
                    const dotIndex = e.target.value.lastIndexOf(".");
                    if (dotIndex > 0) {
                      e.target.setSelectionRange(0, dotIndex);
                    } else {
                      e.target.select();
                    }
                  }}
                />
                {renameTarget.error && (
                  <p style={{ margin: "6px 0 0", fontSize: "0.8rem", color: "#ef4444" }}>
                    {renameTarget.error}
                  </p>
                )}
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setRenameTarget(null)}
                  style={{ padding: "8px 16px", borderRadius: "var(--radius-md)", cursor: "pointer" }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={!renameTarget.newName.trim() || renameTarget.newName.trim() === (renameTarget.file?.name ?? renameTarget.folder?.name ?? "")}
                  style={{ padding: "8px 18px", borderRadius: "var(--radius-md)", cursor: "pointer", fontWeight: 600 }}
                >
                  Rename
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Create Folder Modal */}
      {createFolderTarget && (
        <div className="modal-overlay-bg" onClick={() => setCreateFolderTarget(null)}>
          <div className="modal-dialog-box" style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => setCreateFolderTarget(null)}
              style={{ position: "absolute", top: 16, right: 16, background: "none", border: "none", fontSize: "1.2rem", cursor: "pointer", color: "var(--text-muted)" }}
              aria-label="Close"
            >
              ✕
            </button>

            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
              <div style={{ width: 44, height: 44, borderRadius: "50%", background: "var(--bg-card-subtle)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1.3rem" }}>
                📁
              </div>
              <div>
                <h3 style={{ margin: 0, fontSize: "1.15rem", fontWeight: 700 }}>Create Folder</h3>
                <p style={{ margin: "2px 0 0", fontSize: "0.82rem", color: "var(--text-muted)", wordBreak: "break-all" }}>
                  in {uploadDestination ? `/${uploadDestination.replace(/^\/+/, "")}` : "/"}
                </p>
              </div>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submitCreateFolder();
              }}
            >
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, color: "var(--text-muted)", marginBottom: 6 }}>
                  FOLDER NAME
                </label>
                <input
                  type="text"
                  autoFocus
                  className="auth-input"
                  placeholder="New folder"
                  style={{ width: "100%", padding: "10px 12px", borderRadius: "var(--radius-md)", border: "1px solid var(--border-accent)", background: "var(--bg-card-subtle)", color: "inherit", fontSize: "0.95rem" }}
                  value={createFolderTarget.name}
                  onChange={(e) => setCreateFolderTarget((prev) => prev ? { ...prev, name: e.target.value, error: undefined } : null)}
                />
                {createFolderTarget.error && (
                  <p style={{ margin: "6px 0 0", fontSize: "0.8rem", color: "#ef4444" }}>
                    {createFolderTarget.error}
                  </p>
                )}
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setCreateFolderTarget(null)}
                  style={{ padding: "8px 16px", borderRadius: "var(--radius-md)", cursor: "pointer" }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={!createFolderTarget.name.trim()}
                  style={{ padding: "8px 18px", borderRadius: "var(--radius-md)", cursor: "pointer", fontWeight: 600 }}
                >
                  Create
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Custom Confirmation Modal */}
      {confirmDialog && (
        <div className="modal-overlay-bg" onClick={() => setConfirmDialog(null)}>
          <div className="modal-dialog-box" style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => setConfirmDialog(null)}
              style={{ position: "absolute", top: 16, right: 16, background: "none", border: "none", fontSize: "1.2rem", cursor: "pointer", color: "var(--text-muted)" }}
              aria-label="Close"
            >
              ✕
            </button>

            <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14 }}>
              <div style={{
                width: 44,
                height: 44,
                borderRadius: "50%",
                background: confirmDialog.confirmVariant === "danger" ? "rgba(239, 68, 68, 0.15)" : "rgba(245, 158, 11, 0.15)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "1.3rem",
                flexShrink: 0
              }}>
                {confirmDialog.icon}
              </div>
              <div>
                <h3 style={{ margin: 0, fontSize: "1.15rem", fontWeight: 700 }}>{confirmDialog.title}</h3>
              </div>
            </div>

            <p style={{ fontSize: "0.9rem", color: "var(--text-secondary, #94a3b8)", lineHeight: 1.5, margin: "0 0 20px" }}>
              {confirmDialog.message}
            </p>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setConfirmDialog(null)}
                style={{ padding: "8px 16px", borderRadius: "var(--radius-md)", cursor: "pointer" }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                style={{
                  padding: "8px 18px",
                  borderRadius: "var(--radius-md)",
                  cursor: "pointer",
                  fontWeight: 600,
                  ...(confirmDialog.confirmVariant === "danger" ? { background: "#ef4444", borderColor: "#ef4444", color: "#fff" } : {})
                }}
                onClick={async () => {
                  const action = confirmDialog.action;
                  setConfirmDialog(null);
                  await action();
                }}
              >
                {confirmDialog.confirmText}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
