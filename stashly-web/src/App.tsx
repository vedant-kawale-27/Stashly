/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

import { useEffect, useState } from "react";
import { BrokerClient } from "./api";
import { AuthModal } from "./components/AuthModal";
import { DeviceList } from "./components/DeviceList";
import { FileBrowser } from "./components/FileBrowser";
import { LandingPage } from "./components/LandingPage";
import { PairingPanel } from "./components/PairingPanel";

const STORAGE_KEYS = {
  token: "stashly_token",
  email: "stashly_email",
  masterKey: "stashly_master_key",
  masterKeys: "stashly_master_keys",
  theme: "stashly_theme",
};

const DEFAULT_BROKER_URL =
  import.meta.env.VITE_BROKER_URL ||
  (typeof window !== "undefined" && window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1"
    ? `${window.location.protocol}//${window.location.hostname}:4000`
    : "http://localhost:4000");

export default function App() {
  const [token, setToken] = useState<string>(() => localStorage.getItem(STORAGE_KEYS.token) ?? "");
  const [userEmail, setUserEmail] = useState<string>(() => localStorage.getItem(STORAGE_KEYS.email) ?? "");
  const [legacyMasterKey, setLegacyMasterKey] = useState<string>(() => localStorage.getItem(STORAGE_KEYS.masterKey) ?? "");
  const [masterKeys, setMasterKeys] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEYS.masterKeys) ?? "{}") as Record<string, string>;
    } catch {
      return {};
    }
  });
  const [theme, setTheme] = useState<"light" | "dark">(() => (localStorage.getItem(STORAGE_KEYS.theme) as "light" | "dark") || "light");
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authModalMode, setAuthModalMode] = useState<"login" | "register">("login");

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
    localStorage.setItem(STORAGE_KEYS.theme, theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  };

  useEffect(() => {
    if (token) localStorage.setItem(STORAGE_KEYS.token, token);
    else localStorage.removeItem(STORAGE_KEYS.token);
  }, [token]);

  useEffect(() => {
    if (userEmail) localStorage.setItem(STORAGE_KEYS.email, userEmail);
    else localStorage.removeItem(STORAGE_KEYS.email);
  }, [userEmail]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.masterKeys, JSON.stringify(masterKeys));
  }, [masterKeys]);

  useEffect(() => {
    if (!token) return;
    const presenceClient = new BrokerClient(DEFAULT_BROKER_URL, token);
    const heartbeat = () => void presenceClient.setPresence(true).catch(() => {});
    heartbeat();
    const timer = window.setInterval(heartbeat, 15_000);
    return () => window.clearInterval(timer);
  }, [token]);

  const client = new BrokerClient(DEFAULT_BROKER_URL, token || undefined);
  const masterKey = selectedDeviceId ? masterKeys[selectedDeviceId] ?? legacyMasterKey : "";

  function setSelectedDeviceMasterKey(key: string) {
    if (!selectedDeviceId) return;
    setMasterKeys((current) => ({ ...current, [selectedDeviceId]: key }));
  }

  async function clearLocalKeyData() {
    localStorage.removeItem(STORAGE_KEYS.masterKey);
    localStorage.removeItem(STORAGE_KEYS.masterKeys);
    setLegacyMasterKey("");
    setMasterKeys({});

    if ("caches" in window) {
      const cacheNames = await window.caches.keys();
      await Promise.all(cacheNames.map((cacheName) => window.caches.delete(cacheName)));
    }
  }

  function handleLogout() {
    void client.setPresence(false).catch(() => {});
    setToken("");
    setUserEmail("");
    setSelectedDeviceId(null);
  }

  function handleOpenAuth(mode: "login" | "register" = "login") {
    setAuthModalMode(mode);
    setAuthModalOpen(true);
  }

  function handleAuthenticated(newToken: string, email: string) {
    setToken(newToken);
    setUserEmail(email);
    setAuthModalOpen(false);
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      {!token ? (
        <>
          <LandingPage
            theme={theme}
            onToggleTheme={toggleTheme}
            onOpenAuth={handleOpenAuth}
          />
          <AuthModal
            isOpen={authModalOpen}
            initialMode={authModalMode}
            client={client}
            onClose={() => setAuthModalOpen(false)}
            onAuthenticated={handleAuthenticated}
          />
        </>
      ) : (
        <>
          {/* Main Dashboard Navbar */}
          <header className="site-header">
            <div className="header-inner">
              <div className="brand-badge-box">
                <div className="brand-logo-disc">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect width="14" height="20" x="5" y="2" rx="3" ry="3" />
                    <path d="M12 18h.01" />
                    <path d="M9 6h6" />
                  </svg>
                </div>
                <div>
                  <span className="brand-title-text">Stashly</span>
                  <span className="btn-pill-cyan" style={{ marginLeft: 10, padding: "2px 8px", fontSize: "0.72rem" }}>
                    Console
                  </span>
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <button
                  onClick={toggleTheme}
                  className="btn-icon"
                  title={`Switch to ${theme === "dark" ? "Light" : "Dark"} Mode`}
                  aria-label="Toggle Theme"
                >
                  {theme === "dark" ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="5" />
                      <line x1="12" y1="1" x2="12" y2="3" />
                      <line x1="12" y1="21" x2="12" y2="23" />
                      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                      <line x1="1" y1="12" x2="3" y2="12" />
                      <line x1="21" y1="12" x2="23" y2="12" />
                      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                    </svg>
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                    </svg>
                  )}
                </button>

                <div style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--bg-card-subtle)", padding: "4px 12px 4px 6px", borderRadius: "var(--radius-full)", border: "1px solid var(--border-subtle)" }}>
                  <div style={{ width: 24, height: 24, borderRadius: "50%", background: "var(--primary-gradient)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.75rem", fontWeight: 700 }}>
                    {userEmail ? userEmail[0].toUpperCase() : "U"}
                  </div>
                  <span style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text-main)" }}>{userEmail}</span>
                </div>

                <button className="btn-secondary btn-small" onClick={handleLogout}>
                  Sign Out
                </button>
              </div>
            </div>
          </header>

          {/* System Telemetry Strip */}
          <div className="workspace-shell" style={{ paddingBottom: 0 }}>
            <div className="workspace-status-bar">
              <div className="status-stat-group">
                <div className="status-stat-item">
                  <span style={{ color: "var(--text-muted)" }}>Broker:</span>
                  <span className="font-mono" style={{ fontWeight: 600, color: "var(--text-main)" }}>{DEFAULT_BROKER_URL}</span>
                </div>
                <div className="status-stat-item">
                  <span style={{ color: "var(--text-muted)" }}>Transport:</span>
                  <span className="font-mono" style={{ fontWeight: 600, color: "var(--text-main)" }}>WSS / TLS 1.3</span>
                </div>
                <div className="status-stat-item">
                  <span style={{ color: "var(--text-muted)" }}>Security:</span>
                  <span className="font-mono" style={{ fontWeight: 600, color: "var(--text-main)" }}>AES-256-GCM Hardware E2EE</span>
                </div>
              </div>

              <div>
                <span className="badge-e2e" style={{ background: masterKey ? "rgba(16, 185, 129, 0.15)" : "rgba(245, 158, 11, 0.15)", color: masterKey ? "#10b981" : "#f59e0b" }}>
                  ● {masterKey ? "Master Key Configured" : "Master Key Not Set"}
                </span>
              </div>
            </div>
          </div>

          {/* Main Dashboard Workspace */}
          <main className="workspace-shell">
            <PairingPanel client={client} />

            <div className="workspace-columns">
              <div>
                <DeviceList
                  client={client}
                  brokerUrl={DEFAULT_BROKER_URL}
                  token={token}
                  selectedDeviceId={selectedDeviceId}
                  onSelectDevice={setSelectedDeviceId}
                />
              </div>

              <div>
                <FileBrowser
                  client={client}
                  deviceId={selectedDeviceId}
                  masterKey={masterKey}
                  onMasterKeyChange={setSelectedDeviceMasterKey}
                  onClearLocalKeyData={clearLocalKeyData}
                />
              </div>
            </div>
          </main>
        </>
      )}
    </div>
  );
}
