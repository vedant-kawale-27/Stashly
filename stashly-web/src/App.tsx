/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

import { useEffect, useState } from "react";
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { BrokerClient, clearBrowserApiCache, Device } from "./api";
import { AuthModal } from "./components/AuthModal";
import { DeviceList } from "./components/DeviceList";
import { FileBrowser } from "./components/FileBrowser";
import { LandingPage } from "./components/LandingPage";
import { PairingPanel } from "./components/PairingPanel";
import { SettingsPage } from "./components/SettingsPage";
import { SharePage } from "./components/SharePage";
import { clearFileListViewCache } from "./components/FileBrowser";
import { clearOfflineDownloads } from "./offlineCache";
import { startRealtime, subscribeRealtime } from "./realtime";

const KEYS = { token: "stashly_token", email: "stashly_email", master: "stashly_master_key", masters: "stashly_master_keys", theme: "stashly_theme" };
const BROKER = import.meta.env.VITE_BROKER_URL || (window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1" ? `${window.location.protocol}//${window.location.hostname}:4000` : "http://localhost:4000");

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const [token, setToken] = useState(() => localStorage.getItem(KEYS.token) ?? "");
  const [email, setEmail] = useState(() => localStorage.getItem(KEYS.email) ?? "");
  const [legacyKey, setLegacyKey] = useState(() => localStorage.getItem(KEYS.master) ?? "");
  const [masterKeys, setMasterKeys] = useState<Record<string, string>>(() => { try { return JSON.parse(localStorage.getItem(KEYS.masters) ?? "{}"); } catch { return {}; } });
  const [theme, setTheme] = useState<"light" | "dark">(() => (localStorage.getItem(KEYS.theme) as "light" | "dark") || "light");
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [fileSearch, setFileSearch] = useState("");
  const [fileView, setFileView] = useState<"grid" | "list">(() => (localStorage.getItem("stashly_file_view") as "grid" | "list") || "grid");
  const client = new BrokerClient(BROKER, token || undefined);
  const masterKey = deviceId ? masterKeys[deviceId] ?? legacyKey : "";
  const activeDevice = devices.find((device) => device.id === deviceId);
  const ownedDevices = devices.filter((device) => device.role === "owner");
  const sharedDevices = devices.filter((device) => device.role && device.role !== "owner");

  useEffect(() => { document.documentElement.classList.toggle("dark", theme === "dark"); localStorage.setItem(KEYS.theme, theme); }, [theme]);
  useEffect(() => { token ? localStorage.setItem(KEYS.token, token) : localStorage.removeItem(KEYS.token); }, [token]);
  useEffect(() => { email ? localStorage.setItem(KEYS.email, email) : localStorage.removeItem(KEYS.email); }, [email]);
  useEffect(() => { localStorage.setItem(KEYS.masters, JSON.stringify(masterKeys)); }, [masterKeys]);
  useEffect(() => { localStorage.setItem("stashly_file_view", fileView); }, [fileView]);
  useEffect(() => {
    if (!token) return;
    let active = true;
    const deviceClient = new BrokerClient(BROKER, token);
    const fetchDevices = () => {
      deviceClient.listDevices(true).then((list) => {
        if (!active) return;
        setDevices(list);
        setDeviceId((current) => current && list.some((device) => device.id === current) ? current : (list[0]?.id ?? null));
      }).catch(() => {
        if (active) setDevices([]);
      });
    };
    fetchDevices();
    const interval = window.setInterval(fetchDevices, 5000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [token]);

  useEffect(() => {
    if (!token) return;
    return startRealtime(BROKER, token);
  }, [token]);

  useEffect(() => {
    if (!token) return;
    return subscribeRealtime((event) => {
      if (!event.deviceId) return;
      if (event.type === "device_telemetry_changed") {
        setDevices((prev) =>
          prev.map((d) =>
            d.id === event.deviceId
              ? {
                  ...d,
                  ...(event.status ? { status: event.status } : {}),
                  ...(event.modelName !== undefined ? { modelName: event.modelName } : {}),
                  ...(event.modelNumber !== undefined ? { modelNumber: event.modelNumber } : {}),
                  ...(event.androidVersion !== undefined ? { androidVersion: event.androidVersion } : {}),
                  ...(event.osVersion !== undefined ? { osVersion: event.osVersion } : {}),
                  ...(event.appVersion !== undefined ? { appVersion: event.appVersion } : {}),
                  ...(event.batteryLevel !== undefined ? { batteryLevel: event.batteryLevel } : {}),
                  ...(event.storageTotalMb !== undefined ? { storageTotalMb: event.storageTotalMb } : {}),
                  ...(event.storageFreeMb !== undefined ? { storageFreeMb: event.storageFreeMb } : {}),
                  ...(event.sdcardMounted !== undefined ? { sdcardMounted: event.sdcardMounted } : {}),
                  ...(event.sdcardTotalMb !== undefined ? { sdcardTotalMb: event.sdcardTotalMb } : {}),
                  ...(event.sdcardFreeMb !== undefined ? { sdcardFreeMb: event.sdcardFreeMb } : {}),
                }
              : d
          )
        );
      } else if (event.type === "device_sharing_changed") {
        setDevices((prev) =>
          prev.map((d) =>
            d.id === event.deviceId
              ? {
                  ...d,
                  ...(event.sharingPaused !== undefined ? { sharingPaused: event.sharingPaused } : {}),
                  ...(event.sharingEnabled !== undefined ? { sharingEnabled: event.sharingEnabled } : {}),
                }
              : d
          )
        );
      }
    });
  }, [token]);
  useEffect(() => {
    if (!token) return;
    const presence = new BrokerClient(BROKER, token);
    const beat = () => void presence.setPresence(true).catch(() => { });
    beat();
    const timer = window.setInterval(beat, 15000);

    const handleUnload = () => {
      try {
        fetch(`${BROKER}/devices/presence`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
          keepalive: true,
        }).catch(() => { });
      } catch { }
    };

    window.addEventListener("pagehide", handleUnload);
    window.addEventListener("beforeunload", handleUnload);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pagehide", handleUnload);
      window.removeEventListener("beforeunload", handleUnload);
      void presence.setPresence(false).catch(() => { });
    };
  }, [token]);

  async function logout() {
    try {
      await client.setPresence(false);
    } catch { }
    clearBrowserApiCache();
    clearFileListViewCache();
    void clearOfflineDownloads().catch(() => undefined);
    setToken(""); setEmail(""); setDeviceId(null); navigate("/");
  }

  async function clearLocalKeyData() {
    localStorage.removeItem(KEYS.master); localStorage.removeItem(KEYS.masters); setLegacyKey(""); setMasterKeys({});
    clearBrowserApiCache();
    clearFileListViewCache();
    await clearOfflineDownloads().catch(() => undefined);
    if ("caches" in window) await Promise.all((await window.caches.keys()).map((name) => window.caches.delete(name)));
  }

  if (window.location.pathname.startsWith("/share/")) {
    const shareToken = decodeURIComponent(window.location.pathname.slice("/share/".length).split("/")[0] ?? "");
    return <SharePage brokerUrl={BROKER} token={shareToken} />;
  }
  if (!token) return <><LandingPage theme={theme} onToggleTheme={() => setTheme((value) => value === "dark" ? "light" : "dark")} onOpenAuth={(mode = "login") => { setAuthMode(mode); setAuthOpen(true); }} /><AuthModal isOpen={authOpen} initialMode={authMode} client={client} onClose={() => setAuthOpen(false)} onAuthenticated={(newToken, newEmail) => { setToken(newToken); setEmail(newEmail); setAuthOpen(false); navigate("/files"); }} /></>;

  return <div className="app-shell app-shell-manager">
    <header className="site-header"><div className="header-inner">
      <div className="brand-badge-box"><div className="brand-logo-disc">S</div><div><span className="brand-title-text">Stashly</span><span className="btn-pill-cyan brand-console-label">Console</span></div></div>
      <div className="header-actions"><button className="btn-icon" onClick={() => setTheme((value) => value === "dark" ? "light" : "dark")} aria-label="Toggle theme">{theme === "dark" ? "☼" : "☾"}</button><button className="account-chip" onClick={() => navigate("/settings")}><span className="account-avatar">{email[0]?.toUpperCase() ?? "U"}</span><span>{email}</span></button><button className="btn-secondary btn-small" onClick={logout}>Sign out</button></div>
    </div></header>
    <div className="manager-layout">
      <aside className="manager-sidebar" aria-label="File manager navigation">
        <button className="sidebar-primary-action" onClick={() => navigate("/files")}>＋ <span>New activity</span></button>
        <nav className="sidebar-nav">
          <NavLink to="/files" className={({ isActive }) => `sidebar-nav-item${isActive && !location.search ? " active" : ""}`}>▦ <span>All files</span></NavLink>
          <NavLink to="/files?view=trash" className={({ isActive }) => `sidebar-nav-item${isActive && location.search.includes("trash") ? " active" : ""}`}>♲ <span>Trash</span></NavLink>
          <div className="sidebar-section-label">My devices</div>
          {ownedDevices.map((device) => {
            const hasStorage = device.storageTotalMb != null && device.storageFreeMb != null && device.storageTotalMb > 0;
            const usedMb = hasStorage ? Math.max(0, device.storageTotalMb! - device.storageFreeMb!) : 0;
            const usedPercent = hasStorage ? Math.min(100, Math.max(0, (usedMb / device.storageTotalMb!) * 100)) : 0;

            const hasSdCard = device.platform === "android" && device.sdcardMounted === true && device.sdcardTotalMb != null && device.sdcardTotalMb > 0;
            const sdUsedMb = hasSdCard && device.sdcardFreeMb != null ? Math.max(0, device.sdcardTotalMb! - device.sdcardFreeMb!) : 0;
            const sdUsedPercent = hasSdCard && device.sdcardTotalMb ? Math.min(100, Math.max(0, (sdUsedMb / device.sdcardTotalMb!) * 100)) : 0;

            const formatMb = (mb?: number | null) => {
              if (mb == null || mb < 0) return "Unavailable";
              if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
              return `${Math.round(mb)} MB`;
            };

            return (
              <button
                key={device.id}
                className={`sidebar-device-item${device.id === deviceId ? " selected" : ""}`}
                onClick={() => { setDeviceId(device.id); navigate("/files"); }}
                type="button"
              >
                <div className="sidebar-device-top">
                  <span className={`sidebar-status-dot ${device.sharingPaused ? "paused" : device.status}`} />
                  <span className="sidebar-device-icon">{device.platform === "windows" ? "💻" : "📱"}</span>
                  <span className="sidebar-device-name" title={device.name}>{device.name}</span>
                </div>
                {hasStorage && (
                  <div className="sidebar-device-storage">
                    <div className="sidebar-device-storage-track">
                      <div className="sidebar-device-storage-fill" style={{ width: `${usedPercent}%` }} />
                    </div>
                    <div className="sidebar-device-storage-text">
                      <span>{formatMb(usedMb)} used</span>
                      <span>of {formatMb(device.storageTotalMb)}</span>
                    </div>
                  </div>
                )}
                {hasSdCard && (
                  <div className="sidebar-device-storage sidebar-device-storage-sdcard">
                    <div className="sidebar-device-storage-track">
                      <div className="sidebar-device-storage-fill sidebar-device-storage-fill-sdcard" style={{ width: `${sdUsedPercent}%` }} />
                    </div>
                    <div className="sidebar-device-storage-text">
                      <span>SD: {formatMb(sdUsedMb)} used</span>
                      <span>of {formatMb(device.sdcardTotalMb)}</span>
                    </div>
                  </div>
                )}
              </button>
            );
          })}
          <div className="sidebar-section-label">Shared with me</div>
          {sharedDevices.map((device) => {
            const hasStorage = device.storageTotalMb != null && device.storageFreeMb != null && device.storageTotalMb > 0;
            const usedMb = hasStorage ? Math.max(0, device.storageTotalMb! - device.storageFreeMb!) : 0;
            const usedPercent = hasStorage ? Math.min(100, Math.max(0, (usedMb / device.storageTotalMb!) * 100)) : 0;

            const hasSdCard = device.platform === "android" && device.sdcardMounted === true && device.sdcardTotalMb != null && device.sdcardTotalMb > 0;
            const sdUsedMb = hasSdCard && device.sdcardFreeMb != null ? Math.max(0, device.sdcardTotalMb! - device.sdcardFreeMb!) : 0;
            const sdUsedPercent = hasSdCard && device.sdcardTotalMb ? Math.min(100, Math.max(0, (sdUsedMb / device.sdcardTotalMb!) * 100)) : 0;

            const formatMb = (mb?: number | null) => {
              if (mb == null || mb < 0) return "Unavailable";
              if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
              return `${Math.round(mb)} MB`;
            };

            return (
              <button
                key={device.id}
                className={`sidebar-device-item${device.id === deviceId ? " selected" : ""}`}
                onClick={() => { setDeviceId(device.id); navigate("/files"); }}
                type="button"
              >
                <div className="sidebar-device-top">
                  <span className={`sidebar-status-dot ${device.sharingPaused ? "paused" : device.status}`} />
                  <span className="sidebar-device-icon">{device.platform === "windows" ? "💻" : "📱"}</span>
                  <span className="sidebar-device-name" title={device.name}>{device.name}</span>
                </div>
                {hasStorage && (
                  <div className="sidebar-device-storage">
                    <div className="sidebar-device-storage-track">
                      <div className="sidebar-device-storage-fill" style={{ width: `${usedPercent}%` }} />
                    </div>
                    <div className="sidebar-device-storage-text">
                      <span>{formatMb(usedMb)} used</span>
                      <span>of {formatMb(device.storageTotalMb)}</span>
                    </div>
                  </div>
                )}
                {hasSdCard && (
                  <div className="sidebar-device-storage sidebar-device-storage-sdcard">
                    <div className="sidebar-device-storage-track">
                      <div className="sidebar-device-storage-fill sidebar-device-storage-fill-sdcard" style={{ width: `${sdUsedPercent}%` }} />
                    </div>
                    <div className="sidebar-device-storage-text">
                      <span>SD: {formatMb(sdUsedMb)} used</span>
                      <span>of {formatMb(device.sdcardTotalMb)}</span>
                    </div>
                  </div>
                )}
              </button>
            );
          })}
          <NavLink to="/devices" className={({ isActive }) => `sidebar-nav-item${isActive ? " active" : ""}`}>⌘ <span>Manage devices</span></NavLink>
          <NavLink to="/settings" className={({ isActive }) => `sidebar-nav-item${isActive ? " active" : ""}`}>⚙ <span>Settings</span></NavLink>
        </nav>
        {activeDevice && (
          <div className="sidebar-device-summary">
            <span className="eyebrow">Selected node</span>
            <strong>{activeDevice.name}</strong>
            <span className={activeDevice.sharingPaused ? "sidebar-warning" : "sidebar-muted"}>
              {activeDevice.sharingPaused ? "Sharing paused by owner" : activeDevice.status === "online" ? "Live stream available" : "Offline"}
            </span>
          </div>
        )}
      </aside>
      <main className="workspace-shell manager-main">
        <Routes>
          <Route path="/files" element={<div className="page-view"><FileBrowser client={client} deviceId={deviceId} onSelectDevice={setDeviceId} devices={devices} masterKey={masterKey} searchQuery={fileSearch} onSearchQueryChange={setFileSearch} viewMode={fileView} onViewModeChange={setFileView} /></div>} />
          <Route path="/devices" element={<div className="page-view"><div className="page-heading"><div><span className="eyebrow">Connections</span><h1>Devices</h1><p>Pair phones, manage access, and check connection status.</p></div></div><PairingPanel client={client} /><DeviceList client={client} brokerUrl={BROKER} token={token} selectedDeviceId={deviceId} onSelectDevice={setDeviceId} masterKeys={masterKeys} onMasterKeyChange={(id, key) => setMasterKeys((old) => ({ ...old, [id]: key }))} onClearLocalKeyData={clearLocalKeyData} /></div>} />
          <Route path="/settings" element={<SettingsPage client={client} email={email} onLogout={logout} onClearLocalKeyData={clearLocalKeyData} />} />
          <Route path="*" element={<Navigate to="/files" replace />} />
        </Routes>
      </main>
    </div>
  </div>;
}
