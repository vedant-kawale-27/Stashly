import { useEffect, useState } from "react";
import { Navigate, NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { BrokerClient, clearBrowserApiCache, Device } from "./api";
import { AuthModal } from "./components/AuthModal";
import { DeviceList } from "./components/DeviceList";
import { DevicePicker } from "./components/DevicePicker";
import { FileBrowser } from "./components/FileBrowser";
import { LandingPage } from "./components/LandingPage";
import { PairingPanel } from "./components/PairingPanel";
import { SettingsPage } from "./components/SettingsPage";
import { clearFileListViewCache } from "./components/FileBrowser";
import { clearOfflineDownloads } from "./offlineCache";

const KEYS = { token: "stashly_token", email: "stashly_email", master: "stashly_master_key", masters: "stashly_master_keys", theme: "stashly_theme" };
const BROKER = import.meta.env.VITE_BROKER_URL || (window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1" ? `${window.location.protocol}//${window.location.hostname}:4000` : "http://localhost:4000");

export default function App() {
  const navigate = useNavigate();
  const [token, setToken] = useState(() => localStorage.getItem(KEYS.token) ?? "");
  const [email, setEmail] = useState(() => localStorage.getItem(KEYS.email) ?? "");
  const [legacyKey, setLegacyKey] = useState(() => localStorage.getItem(KEYS.master) ?? "");
  const [masterKeys, setMasterKeys] = useState<Record<string, string>>(() => { try { return JSON.parse(localStorage.getItem(KEYS.masters) ?? "{}"); } catch { return {}; } });
  const [theme, setTheme] = useState<"light" | "dark">(() => (localStorage.getItem(KEYS.theme) as "light" | "dark") || "light");
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const client = new BrokerClient(BROKER, token || undefined);
  const masterKey = deviceId ? masterKeys[deviceId] ?? legacyKey : "";

  useEffect(() => { document.documentElement.classList.toggle("dark", theme === "dark"); localStorage.setItem(KEYS.theme, theme); }, [theme]);
  useEffect(() => { token ? localStorage.setItem(KEYS.token, token) : localStorage.removeItem(KEYS.token); }, [token]);
  useEffect(() => { email ? localStorage.setItem(KEYS.email, email) : localStorage.removeItem(KEYS.email); }, [email]);
  useEffect(() => { localStorage.setItem(KEYS.masters, JSON.stringify(masterKeys)); }, [masterKeys]);
  useEffect(() => {
    if (!token) return;
    const presence = new BrokerClient(BROKER, token);
    const beat = () => void presence.setPresence(true).catch(() => {});
    beat();
    const timer = window.setInterval(beat, 15000);

    const handleUnload = () => {
      try {
        fetch(`${BROKER}/devices/presence`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
          keepalive: true,
        }).catch(() => {});
      } catch {}
    };

    window.addEventListener("pagehide", handleUnload);
    window.addEventListener("beforeunload", handleUnload);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pagehide", handleUnload);
      window.removeEventListener("beforeunload", handleUnload);
      void presence.setPresence(false).catch(() => {});
    };
  }, [token]);

  async function logout() {
    try {
      await client.setPresence(false);
    } catch {}
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

  if (!token) return <><LandingPage theme={theme} onToggleTheme={() => setTheme((value) => value === "dark" ? "light" : "dark")} onOpenAuth={(mode = "login") => { setAuthMode(mode); setAuthOpen(true); }} /><AuthModal isOpen={authOpen} initialMode={authMode} client={client} onClose={() => setAuthOpen(false)} onAuthenticated={(newToken, newEmail) => { setToken(newToken); setEmail(newEmail); setAuthOpen(false); navigate("/files"); }} /></>;

  return <div className="app-shell">
    <header className="site-header"><div className="header-inner">
      <div className="brand-badge-box"><div className="brand-logo-disc">S</div><div><span className="brand-title-text">Stashly</span><span className="btn-pill-cyan brand-console-label">Console</span></div></div>
      <nav className="workspace-nav" aria-label="Workspace navigation">
        <NavLink to="/files" className={({ isActive }) => isActive ? "workspace-nav-item active" : "workspace-nav-item"}>Files</NavLink>
        <NavLink to="/devices" className={({ isActive }) => isActive ? "workspace-nav-item active" : "workspace-nav-item"}>Devices</NavLink>
        <NavLink to="/settings" className={({ isActive }) => isActive ? "workspace-nav-item active" : "workspace-nav-item"}>Settings</NavLink>
      </nav>
      <div className="header-actions"><button className="btn-icon" onClick={() => setTheme((value) => value === "dark" ? "light" : "dark")} aria-label="Toggle theme">{theme === "dark" ? "☼" : "☾"}</button><button className="account-chip" onClick={() => navigate("/settings")}><span className="account-avatar">{email[0]?.toUpperCase() ?? "U"}</span><span>{email}</span></button><button className="btn-secondary btn-small" onClick={logout}>Sign out</button></div>
    </div></header>
    <main className="workspace-shell">
      <Routes>
        <Route path="/files" element={<div className="page-view"><div className="page-heading"><div><span className="eyebrow">Storage</span><h1>Files</h1><p>Browse and manage files from your connected phone.</p></div><DevicePicker client={client} selectedDeviceId={deviceId} onSelectDevice={setDeviceId} onDevicesChange={setDevices} /></div><FileBrowser client={client} deviceId={deviceId} onSelectDevice={setDeviceId} devices={devices} masterKey={masterKey} /></div>} />
        <Route path="/devices" element={<div className="page-view"><div className="page-heading"><div><span className="eyebrow">Connections</span><h1>Devices</h1><p>Pair phones, manage access, and check connection status.</p></div></div><PairingPanel client={client} /><DeviceList client={client} brokerUrl={BROKER} token={token} selectedDeviceId={deviceId} onSelectDevice={setDeviceId} masterKeys={masterKeys} onMasterKeyChange={(id, key) => setMasterKeys((old) => ({ ...old, [id]: key }))} onClearLocalKeyData={clearLocalKeyData} /></div>} />
        <Route path="/settings" element={<SettingsPage client={client} email={email} onLogout={logout} onClearLocalKeyData={clearLocalKeyData} />} />
        <Route path="*" element={<Navigate to="/files" replace />} />
      </Routes>
    </main>
  </div>;
}
