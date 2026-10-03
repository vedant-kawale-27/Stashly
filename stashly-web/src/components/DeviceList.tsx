/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

import React, { useEffect, useState } from "react";
import { BrokerClient, Device } from "../api";
import { base64ToBytes } from "../crypto";
import { BluetoothKeyModal } from "./BluetoothKeyModal";
import { WindowsMountModal } from "./WindowsMountModal";

function formatTimestamp(value?: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

function formatSize(valueMb?: number | null): string {
  if (valueMb == null || valueMb < 0) return "Unavailable";
  if (valueMb >= 1024) return `${(valueMb / 1024).toFixed(1)} GB`;
  return `${valueMb} MB`;
}

function scopeLabel(user: NonNullable<Device["sharedWith"]>[number]): string {
  if (user.scopeMode === "ALL") return "All internal storage";
  if (user.scopeMode === "CUSTOM_FILE") {
    return `File: ${user.scopeName ?? user.scopePath ?? "Selected file"}`;
  }
  if (user.scopeMode === "CUSTOM_FOLDER") {
    return `Folder: ${user.scopeName ?? user.scopePath ?? "Selected folder"}`;
  }
  return "No file access selected";
}

const deviceListCache = new Map<string, Device[]>();

function sameDevice(left: Device, right: Device): boolean {
  return left.id === right.id &&
    left.name === right.name &&
    left.platform === right.platform &&
    left.osVersion === right.osVersion &&
    left.appVersion === right.appVersion &&
    left.modelName === right.modelName &&
    left.modelNumber === right.modelNumber &&
    left.androidVersion === right.androidVersion &&
    left.batteryLevel === right.batteryLevel &&
    left.storageTotalMb === right.storageTotalMb &&
    left.storageFreeMb === right.storageFreeMb &&
    left.status === right.status &&
    left.storageQuotaMb === right.storageQuotaMb &&
    left.lastSeenAt === right.lastSeenAt &&
    left.fileCount === right.fileCount &&
    left.sharingEnabled === right.sharingEnabled &&
    JSON.stringify(left.sharedWith ?? []) === JSON.stringify(right.sharedWith ?? []);
}

function reconcileDevices(previous: Device[], next: Device[]): Device[] {
  const previousById = new Map(previous.map((device) => [device.id, device]));
  const reconciled = next.map((device) => {
    const existing = previousById.get(device.id);
    return existing && sameDevice(existing, device) ? existing : device;
  });
  return reconciled.length === previous.length && reconciled.every((device, index) => device === previous[index])
    ? previous
    : reconciled;
}

interface Props {
  client: BrokerClient;
  brokerUrl: string;
  token: string;
  selectedDeviceId: string | null;
  onSelectDevice: (deviceId: string | null) => void;
  masterKeys: Record<string, string>;
  onMasterKeyChange: (deviceId: string, key: string) => void;
  onClearLocalKeyData: () => Promise<void>;
}

export function DeviceList({
  client,
  brokerUrl,
  token,
  selectedDeviceId,
  onSelectDevice,
  masterKeys,
  onMasterKeyChange,
  onClearLocalKeyData,
}: Props) {
  const cacheKey = `${brokerUrl}:${token}`;
  const [devices, setDevices] = useState<Device[]>(() => deviceListCache.get(cacheKey) ?? []);
  const [loading, setLoading] = useState(() => !deviceListCache.has(cacheKey));
  const [error, setError] = useState<string | null>(null);
  const [mountDevice, setMountDevice] = useState<Device | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [visibleKeyId, setVisibleKeyId] = useState<string | null>(null);
  const [keyMessage, setKeyMessage] = useState<Record<string, string>>({});
  const [bluetoothDevice, setBluetoothDevice] = useState<Device | null>(null);
  const [keyManagerDevice, setKeyManagerDevice] = useState<Device | null>(null);
  const loadingRef = React.useRef(false);

  async function loadDevices(force = false, syncFiles = false) {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      setError(null);
      let list = await client.listDevices(force);
      if (syncFiles) {
        await Promise.all(list.filter((device) => device.status === "online").map((device) => client.syncDevice(device.id).catch(() => undefined)));
        list = await client.listDevices(true);
      }
      setDevices((previous) => {
        const reconciled = reconcileDevices(previous, list);
        deviceListCache.set(cacheKey, reconciled);
        return reconciled;
      });
      if (!selectedDeviceId && list.length > 0) {
        onSelectDevice(list[0].id);
      }
    } catch (err: any) {
      setError(err.message || "Failed to load nodes");
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }

  useEffect(() => {
    void loadDevices(false);
    const interval = setInterval(() => loadDevices(true), 6000);
    return () => clearInterval(interval);
  }, []);

  async function handleRename(deviceId: string) {
    if (!newName.trim()) return;
    try {
      await client.renameDevice(deviceId, newName.trim());
      setRenamingId(null);
      await loadDevices(true);
    } catch (err: any) {
      alert("Failed to rename device: " + err.message);
    }
  }

  async function handleUnpair(device: Device) {
    const msg = `Are you sure you want to remove your connection to "${device.name}"? This does not change access for other clients.`;

    if (!confirm(msg)) return;

    try {
      await client.unpairDevice(device.id);
      if (selectedDeviceId === device.id) {
        onSelectDevice(null);
      }
      await loadDevices(true);
    } catch (err: any) {
      alert("Failed to remove device: " + err.message);
    }
  }

  function saveMasterKey(deviceId: string) {
    const key = (keyDrafts[deviceId] ?? masterKeys[deviceId] ?? "").trim();
    try {
      if (base64ToBytes(key).length !== 32) throw new Error("The key must be a 32-byte Base64 AES-256 key.");
      onMasterKeyChange(deviceId, key);
      setKeyMessage((old) => ({ ...old, [deviceId]: "Key saved in this browser." }));
    } catch (error: any) {
      setKeyMessage((old) => ({ ...old, [deviceId]: error.message || "Invalid master key." }));
    }
  }

  function clearMasterKey(deviceId: string) {
    setKeyDrafts((old) => ({ ...old, [deviceId]: "" }));
    onMasterKeyChange(deviceId, "");
    setKeyMessage((old) => ({ ...old, [deviceId]: "Key removed from this browser." }));
  }

  return (
    <div className="panel-box">
      <div className="panel-box-header">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <h3 className="panel-box-title">Connected Storage Nodes</h3>
          <span className="btn-pill-cyan" style={{ padding: "2px 10px", fontSize: "0.75rem" }}>
            {devices.length} {devices.length === 1 ? "Node" : "Nodes"}
          </span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn-secondary btn-small" onClick={() => void onClearLocalKeyData()} title="Remove all keys saved in this browser">Clear local keys</button>
          <button className="btn-icon" onClick={() => void loadDevices(true, true)} title="Refresh device status and files">
          🔄
          </button>
        </div>
      </div>

      <div className="panel-box-body">
        {error && (
          <div style={{ background: "rgba(239, 68, 68, 0.15)", color: "#ef4444", padding: "10px 14px", borderRadius: "var(--radius-sm)", fontSize: "0.85rem", marginBottom: 14 }}>
            {error}
          </div>
        )}

        {loading && devices.length === 0 ? (
          <div style={{ textAlign: "center", padding: "28px 0", color: "var(--text-muted)", fontSize: "0.88rem" }}>
            Querying active storage nodes…
          </div>
        ) : devices.length === 0 ? (
          <div style={{ textAlign: "center", padding: "32px 16px", color: "var(--text-muted)" }}>
            <div style={{ fontSize: "2rem", marginBottom: 8 }}>📱</div>
            <h4 style={{ color: "var(--text-main)", marginBottom: 4 }}>No nodes connected</h4>
            <p style={{ fontSize: "0.85rem" }}>
              Pair your Android handset using the button above to start accessing your encrypted vault.
            </p>
          </div>
        ) : (
          <div>
            {devices.map((d) => {
              const isSelected = selectedDeviceId === d.id;
              const isOnline = d.status === "online";

              return (
                <div
                  key={d.id}
                  className={`node-card-item ${isSelected ? "selected" : ""}`}
                  onClick={() => onSelectDevice(d.id)}
                >
                  <div className="node-item-top">
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ fontSize: "1.4rem" }}>
                        {d.platform === "windows" ? "💻" : "📱"}
                      </span>
                      <div>
                        {renamingId === d.id ? (
                          <div style={{ display: "flex", gap: 4, alignItems: "center" }} onClick={(e) => e.stopPropagation()}>
                            <input
                              type="text"
                              value={newName}
                              onChange={(e) => setNewName(e.target.value)}
                              autoFocus
                              style={{
                                padding: "2px 8px",
                                borderRadius: "var(--radius-sm)",
                                border: "1px solid var(--primary)",
                                fontSize: "0.85rem",
                                background: "var(--bg-card)",
                                color: "var(--text-main)"
                              }}
                            />
                            <button className="btn-primary btn-small" onClick={() => handleRename(d.id)}>Save</button>
                            <button className="btn-secondary btn-small" onClick={() => setRenamingId(null)}>✕</button>
                          </div>
                        ) : (
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span className="node-item-name">{d.name}</span>
                            <button
                              style={{ background: "none", opacity: 0.6, fontSize: "0.8rem", padding: "0 2px" }}
                              title="Rename node"
                              onClick={(e) => {
                                e.stopPropagation();
                                setRenamingId(d.id);
                                setNewName(d.name);
                              }}
                            >
                              ✏️
                            </button>
                          </div>
                        )}
                        <div style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginTop: 2 }}>
                          {d.osVersion ? `Android OS ${d.osVersion}` : "Android Storage Node"}
                        </div>
                      </div>
                    </div>

                    <span className="badge-e2e" style={{ background: isOnline ? "rgba(16, 185, 129, 0.15)" : "rgba(100, 116, 139, 0.15)", color: isOnline ? "#10b981" : "var(--text-muted)" }}>
                      ● {isOnline ? "Live Stream" : "Offline"}
                    </span>
                  </div>

                  <div className="device-card-section" onClick={(e) => e.stopPropagation()}>
                    <div className="device-card-section-heading">
                      <div>
                        <span className="device-card-label">Master encryption key</span>
                        <span className="device-card-help">Configured separately for this device</span>
                      </div>
                      <span className={masterKeys[d.id] ? "device-key-status ready" : "device-key-status"}>{masterKeys[d.id] ? "Configured" : "Not set"}</span>
                    </div>
                    <button className="btn-secondary device-manage-key-button" onClick={() => { setKeyManagerDevice(d); setKeyDrafts((old) => ({ ...old, [d.id]: masterKeys[d.id] ?? "" })); setVisibleKeyId(null); }}>
                      Manage master encryption key
                    </button>
                    {keyMessage[d.id] && <div className="device-card-help device-key-message">{keyMessage[d.id]}</div>}
                  </div>

                  <div className="device-info-grid">
                    <div><span>Model</span><strong>{d.modelName || d.name}</strong><small>{d.modelNumber || "Model number unavailable"}</small></div>
                    <div><span>Android / OS</span><strong>{d.androidVersion || d.osVersion || "Unavailable"}</strong><small>{d.platform}</small></div>
                    <div><span>Battery</span><strong>{typeof d.batteryLevel === "number" ? `${d.batteryLevel}%` : "Unavailable"}</strong><small>{isOnline ? "Live node report" : "Last reported value"}</small></div>
                    <div><span>Storage</span><strong>{d.storageFreeMb != null && d.storageTotalMb != null ? `${formatSize(d.storageFreeMb)} free` : "Unavailable"}</strong><small>{d.storageTotalMb != null ? `${formatSize(d.storageTotalMb)} total` : "Awaiting node report"}</small></div>
                  </div>

                  {/* Each linked client keeps its own scope and sharing state. */}
                  {d.sharedWith && d.sharedWith.length > 0 && (
                    <div style={{ margin: "10px 0 4px", display: "grid", gap: 6 }}>
                      <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Connected clients</span>
                      {d.sharedWith.map((u) => {
                        const sharingStopped = u.sharingEnabled === false;
                        const clientOnline = !sharingStopped && u.isLive === true;
                        return (
                          <div key={u.userId} style={{ background: "var(--bg-card)", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-sm)", padding: "7px 9px", fontSize: "0.75rem" }}>
                            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                              <strong style={{ color: "var(--text-main)" }}>{u.email}</strong>
                              <span style={{ color: sharingStopped ? "#f59e0b" : clientOnline ? "#10b981" : "var(--text-muted)" }}>
                                {sharingStopped ? "Sharing stopped" : clientOnline ? "Online" : "Offline"}
                              </span>
                            </div>
                            <div style={{ color: "var(--primary)", marginTop: 3 }}>{scopeLabel(u)}</div>
                            <div style={{ color: "var(--text-muted)", marginTop: 3 }}>
                              Connected {formatTimestamp(u.connectedAt ?? u.since)} · Last seen {clientOnline ? "Now" : formatTimestamp(u.lastSeenAt)}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {d.sharingEnabled === false && (
                    <div style={{ color: "#f59e0b", fontSize: "0.78rem", marginTop: 7 }}>
                      Your access is currently stopped on the Android node.
                    </div>
                  )}

                  {/* Statistics */}
                  <div className="node-stats-bar-3">
                    <div>
                      <span style={{ color: "var(--text-muted)", display: "block" }}>Synced Files</span>
                      <span style={{ fontWeight: 700, color: "var(--text-main)" }} className="font-mono">{d.fileCount ?? 0}</span>
                    </div>
                    <div>
                      <span style={{ color: "var(--text-muted)", display: "block" }}>Clients</span>
                      <span style={{ fontWeight: 700, color: "var(--text-main)" }}>{d.sharedWith?.length ?? 0}</span>
                    </div>
                    <div>
                      <span style={{ color: "var(--text-muted)", display: "block" }}>Offered Space</span>
                      <span style={{ fontWeight: 700, color: "var(--text-main)" }} className="font-mono">{d.storageQuotaMb > 0 ? `${d.storageQuotaMb} MB` : "Uncapped"}</span>
                    </div>
                  </div>

                  {/* Actions */}
                  <div style={{ display: "flex", gap: 6, marginTop: 10 }} onClick={(e) => e.stopPropagation()}>
                    <button
                      className={`btn-small ${isSelected ? "btn-primary" : "btn-secondary"}`}
                      style={{ flex: 1 }}
                      onClick={() => onSelectDevice(d.id)}
                    >
                      {isSelected ? "✓ Active Vault" : "Browse Files"}
                    </button>
                    <button
                      className="btn-secondary btn-small"
                      title="Mount as Windows Drive"
                      onClick={() => setMountDevice(d)}
                    >
                      💻 Mount Z:
                    </button>
                    <button
                      className="btn-secondary btn-small"
                      style={{ color: "#ef4444" }}
                      title="Remove my connection"
                      onClick={() => handleUnpair(d)}
                    >
                      🗑️
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {mountDevice && (
        <WindowsMountModal
          device={mountDevice}
          onClose={() => setMountDevice(null)}
        />
      )}
      {keyManagerDevice && (
        <div className="modal-overlay-bg" onClick={() => setKeyManagerDevice(null)}>
          <div className="modal-dialog-box device-key-modal" onClick={(event) => event.stopPropagation()}>
            <button className="modal-close-button" onClick={() => setKeyManagerDevice(null)} aria-label="Close master key manager">×</button>
            <span className="eyebrow">Device security</span>
            <h2>Manage master encryption key</h2>
            <p className="device-card-help">{keyManagerDevice.name}</p>
            <label className="device-key-modal-label" htmlFor="device-master-key">Base64 AES-256 master key</label>
            <div className="device-key-row">
              <input
                id="device-master-key"
                type={visibleKeyId === keyManagerDevice.id ? "text" : "password"}
                value={keyDrafts[keyManagerDevice.id] ?? masterKeys[keyManagerDevice.id] ?? ""}
                onChange={(event) => setKeyDrafts((old) => ({ ...old, [keyManagerDevice.id]: event.target.value }))}
                placeholder="Paste the key from Android"
              />
              <button className="btn-secondary btn-small" onClick={() => setVisibleKeyId(visibleKeyId === keyManagerDevice.id ? null : keyManagerDevice.id)}>{visibleKeyId === keyManagerDevice.id ? "Hide" : "Show"}</button>
            </div>
            <p className="device-card-help">The key is stored in this browser only and is never sent to the broker.</p>
            <div className="device-key-modal-actions">
              <button className="btn-secondary" onClick={() => setBluetoothDevice(keyManagerDevice)}>Receive via Bluetooth</button>
              <button className="btn-primary" onClick={() => { saveMasterKey(keyManagerDevice.id); setKeyManagerDevice(null); }}>Save key</button>
              {masterKeys[keyManagerDevice.id] && <button className="btn-secondary" onClick={() => clearMasterKey(keyManagerDevice.id)}>Clear key</button>}
            </div>
            {keyMessage[keyManagerDevice.id] && <div className="device-card-help device-key-message">{keyMessage[keyManagerDevice.id]}</div>}
          </div>
        </div>
      )}
      {bluetoothDevice && (
        <BluetoothKeyModal
          isOpen
          onClose={() => setBluetoothDevice(null)}
          onKeyReceived={(key) => {
            onMasterKeyChange(bluetoothDevice.id, key);
            setKeyDrafts((old) => ({ ...old, [bluetoothDevice.id]: key }));
            setKeyMessage((old) => ({ ...old, [bluetoothDevice.id]: "Key received and saved for this device." }));
            setBluetoothDevice(null);
          }}
        />
      )}
    </div>
  );
}
