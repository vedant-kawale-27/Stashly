import React, { useEffect, useState } from "react";
import { BrokerClient, Device } from "../api";
import { WindowsMountModal } from "./WindowsMountModal";

interface Props {
  client: BrokerClient;
  brokerUrl: string;
  token: string;
  selectedDeviceId: string | null;
  onSelectDevice: (deviceId: string | null) => void;
}

export function DeviceList({
  client,
  brokerUrl,
  token,
  selectedDeviceId,
  onSelectDevice,
}: Props) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mountDevice, setMountDevice] = useState<Device | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");

  async function loadDevices() {
    try {
      setError(null);
      const list = await client.listDevices();
      setDevices(list);
      if (!selectedDeviceId && list.length > 0) {
        onSelectDevice(list[0].id);
      }
    } catch (err: any) {
      setError(err.message || "Failed to load nodes");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadDevices();
    const interval = setInterval(loadDevices, 6000);
    return () => clearInterval(interval);
  }, []);

  async function handleRename(deviceId: string) {
    if (!newName.trim()) return;
    try {
      await client.renameDevice(deviceId, newName.trim());
      setRenamingId(null);
      await loadDevices();
    } catch (err: any) {
      alert("Failed to rename device: " + err.message);
    }
  }

  async function handleUnpair(device: Device) {
    const isOwner = device.role === "owner";
    const msg = isOwner
      ? `Are you sure you want to remove "${device.name}"? This unlinks the device from Stashly.`
      : `Are you sure you want to unlink "${device.name}" from your account?`;

    if (!confirm(msg)) return;

    try {
      await client.unpairDevice(device.id);
      if (selectedDeviceId === device.id) {
        onSelectDevice(null);
      }
      await loadDevices();
    } catch (err: any) {
      alert("Failed to remove device: " + err.message);
    }
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
        <button className="btn-icon" onClick={loadDevices} title="Refresh nodes">
          🔄
        </button>
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
              const isOwner = d.role === "owner";

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

                  {/* Shared user avatars/pills */}
                  {d.sharedWith && d.sharedWith.length > 1 && (
                    <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", margin: "6px 0", display: "flex", gap: 4, alignItems: "center" }}>
                      <span>Shared:</span>
                      {d.sharedWith.map((u) => (
                        <span
                          key={u.userId}
                          style={{
                            background: "var(--bg-card)",
                            border: "1px solid var(--border-subtle)",
                            borderRadius: "var(--radius-full)",
                            padding: "1px 8px",
                            fontWeight: 600
                          }}
                        >
                          {u.email.split("@")[0]}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Statistics */}
                  <div className="node-stats-bar-3">
                    <div>
                      <span style={{ color: "var(--text-muted)", display: "block" }}>Synced Files</span>
                      <span style={{ fontWeight: 700, color: "var(--text-main)" }} className="font-mono">{d.fileCount ?? 0}</span>
                    </div>
                    <div>
                      <span style={{ color: "var(--text-muted)", display: "block" }}>Role</span>
                      <span style={{ fontWeight: 700, color: "var(--text-main)" }}>{isOwner ? "👑 Owner" : "👥 Shared"}</span>
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
                      title={isOwner ? "Remove Node" : "Unlink Node"}
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
          brokerUrl={brokerUrl}
          token={token}
          onClose={() => setMountDevice(null)}
        />
      )}
    </div>
  );
}
