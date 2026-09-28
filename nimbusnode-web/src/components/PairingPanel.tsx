import React, { useState, useEffect } from "react";
import { QRCodeSVG } from "qrcode.react";
import { BrokerClient } from "../api";

interface Props {
  client: BrokerClient;
  onDevicePaired?: () => void;
}

export function PairingPanel({ client, onDevicePaired }: Props) {
  const [token, setToken] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [tab, setTab] = useState<"qr" | "code">("qr");

  // Dynamic broker URL auto-detection for local LAN or production
  const [brokerUrl, setBrokerUrl] = useState<string>(() => {
    if (client.baseUrl.includes("localhost") || client.baseUrl.includes("127.0.0.1")) {
      if (window.location.hostname && window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1") {
        return `http://${window.location.hostname}:4000`;
      }
    }
    return client.baseUrl;
  });

  // Automatically fetch live network LAN IP / Deployed URL from broker /info
  useEffect(() => {
    let mounted = true;
    client.fetchInfo()
      .then((info) => {
        if (mounted && info?.suggestedBrokerUrl) {
          setBrokerUrl(info.suggestedBrokerUrl);
        }
      })
      .catch(() => {
        // Fallback gracefully to client.baseUrl if /info endpoint not ready
      });
    return () => {
      mounted = false;
    };
  }, [client]);

  async function handleGenerateToken() {
    setLoading(true);
    setError(null);
    try {
      // Re-query broker info on generation to catch any network/Wi-Fi changes
      try {
        const info = await client.fetchInfo();
        if (info?.suggestedBrokerUrl) {
          setBrokerUrl(info.suggestedBrokerUrl);
        }
      } catch {
        // continue with existing brokerUrl
      }

      const res = await client.createPairingToken();
      setToken(res.token);
      setExpiresAt(res.expiresAt);
      setIsOpen(true);
    } catch (err: any) {
      setError(err.message || "Failed to generate pairing code");
    } finally {
      setLoading(false);
    }
  }

  function handleCopy() {
    if (!token) return;
    navigator.clipboard.writeText(token);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const qrPayload = token
    ? JSON.stringify({
        type: "stashly_pair",
        brokerUrl: brokerUrl.trim().replace(/\/+$/, ""),
        token: token.trim().toUpperCase()
      })
    : "";

  return (
    <div style={{ marginBottom: 20 }}>
      <div
        style={{
          background: "linear-gradient(135deg, var(--primary-subtle) 0%, var(--bg-card) 100%)",
          border: "1px solid var(--border-accent)",
          borderRadius: "var(--radius-xl)",
          padding: "18px 26px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          boxShadow: "var(--shadow-sm)"
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ fontSize: "1.8rem" }}>📱</div>
          <div>
            <h4 style={{ fontSize: "1.05rem", fontWeight: 800, color: "var(--text-main)", marginBottom: 2 }}>
              Connect Android Handset as a Node
            </h4>
            <p style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
              Pair your phone via instant QR code or 8-digit code to turn it into an encrypted storage node.
            </p>
          </div>
        </div>

        <button
          className="btn-primary"
          onClick={handleGenerateToken}
          disabled={loading}
        >
          {loading ? "Generating…" : "📷 Pair Phone (QR Code)"}
        </button>
      </div>

      {error && <div style={{ background: "rgba(239, 68, 68, 0.15)", color: "#ef4444", padding: "10px 14px", borderRadius: "var(--radius-sm)", fontSize: "0.85rem", marginTop: 12 }}>{error}</div>}

      {isOpen && token && (
        <div className="modal-overlay-bg" onClick={() => setIsOpen(false)}>
          <div className="modal-dialog-box" style={{ textAlign: "center", maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => setIsOpen(false)}
              style={{
                position: "absolute",
                top: 20,
                right: 20,
                background: "none",
                color: "var(--text-muted)",
                fontSize: "1.1rem"
              }}
            >
              ✕
            </button>

            <div style={{ marginBottom: 14 }}>
              <div className="brand-logo-disc" style={{ margin: "0 auto 10px", width: 42, height: 42 }}>
                📱
              </div>
              <h3 style={{ fontSize: "1.25rem", fontWeight: 800 }}>Pair Your Mobile Phone</h3>
              <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginTop: 2 }}>
                Open Stashly on Android and scan this QR code to auto-connect.
              </p>
            </div>

            {/* Tab Switcher */}
            <div style={{ display: "flex", background: "var(--bg-card-subtle)", borderRadius: "var(--radius-md)", padding: 4, marginBottom: 16 }}>
              <button
                type="button"
                onClick={() => setTab("qr")}
                style={{
                  flex: 1,
                  padding: "7px 0",
                  borderRadius: "var(--radius-sm)",
                  background: tab === "qr" ? "var(--bg-card)" : "transparent",
                  color: tab === "qr" ? "var(--primary)" : "var(--text-muted)",
                  fontWeight: 700,
                  fontSize: "0.85rem",
                  boxShadow: tab === "qr" ? "var(--shadow-sm)" : "none"
                }}
              >
                📷 Scan QR Code
              </button>
              <button
                type="button"
                onClick={() => setTab("code")}
                style={{
                  flex: 1,
                  padding: "7px 0",
                  borderRadius: "var(--radius-sm)",
                  background: tab === "code" ? "var(--bg-card)" : "transparent",
                  color: tab === "code" ? "var(--primary)" : "var(--text-muted)",
                  fontWeight: 700,
                  fontSize: "0.85rem",
                  boxShadow: tab === "code" ? "var(--shadow-sm)" : "none"
                }}
              >
                🔢 8-Digit Code
              </button>
            </div>

            {tab === "qr" ? (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                <div
                  style={{
                    background: "#ffffff",
                    padding: "16px",
                    borderRadius: "var(--radius-lg)",
                    boxShadow: "var(--shadow-sm)",
                    border: "1px solid var(--border-light)",
                    display: "inline-block",
                    marginBottom: 12
                  }}
                >
                  <QRCodeSVG
                    value={qrPayload}
                    size={210}
                    level="M"
                    includeMargin={false}
                  />
                </div>

                <div style={{ width: "100%", marginBottom: 12, textAlign: "left" }}>
                  <label style={{ fontSize: "0.75rem", fontWeight: 700, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                    Broker LAN URL for phone:
                  </label>
                  <input
                    type="text"
                    value={brokerUrl}
                    onChange={(e) => setBrokerUrl(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "7px 10px",
                      fontSize: "0.82rem",
                      borderRadius: "var(--radius-sm)",
                      border: "1px solid var(--border-light)",
                      background: "var(--bg-card-subtle)",
                      color: "var(--text-main)"
                    }}
                  />
                </div>

                <div style={{ fontSize: "0.82rem", color: "var(--text-muted)", marginBottom: 14 }}>
                  In Stashly app: Tap <strong>"📷 Scan QR Code"</strong> on the New Connection tab.
                </div>
              </div>
            ) : (
              <div>
                <div
                  style={{
                    background: "var(--bg-card-subtle)",
                    border: "2px dashed var(--primary)",
                    borderRadius: "var(--radius-md)",
                    padding: "18px",
                    margin: "12px 0"
                  }}
                >
                  <div style={{ fontSize: "0.75rem", fontWeight: 800, color: "var(--primary)", textTransform: "uppercase", letterSpacing: 1 }}>
                    Pairing Code
                  </div>
                  <div
                    className="font-mono"
                    style={{
                      fontSize: "2.2rem",
                      fontWeight: 900,
                      letterSpacing: 6,
                      color: "var(--text-main)",
                      margin: "8px 0"
                    }}
                  >
                    {token}
                  </div>
                  <button
                    className="btn-secondary btn-small"
                    onClick={handleCopy}
                  >
                    {copied ? "✓ Copied to clipboard" : "📋 Copy Code"}
                  </button>
                </div>

                <div
                  style={{
                    background: "var(--bg-card-subtle)",
                    borderRadius: "var(--radius-md)",
                    padding: "12px 14px",
                    textAlign: "left",
                    fontSize: "0.82rem",
                    color: "var(--text-muted)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                    marginBottom: 14
                  }}
                >
                  <div>1. Open <strong>Stashly App</strong> &rarr; <strong>New Connection</strong></div>
                  <div>2. Broker URL: <code>{brokerUrl}</code></div>
                  <div>3. Enter the 8-digit code above &amp; tap Pair</div>
                </div>
              </div>
            )}

            {expiresAt && (
              <div style={{ fontSize: "0.76rem", color: "var(--text-muted)", marginBottom: 16 }}>
                ⏱ Code expires at {new Date(expiresAt).toLocaleTimeString()}
              </div>
            )}

            <button
              className="btn-primary"
              style={{ width: "100%" }}
              onClick={() => {
                setIsOpen(false);
                if (onDevicePaired) onDevicePaired();
              }}
            >
              I Have Paired My Phone
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
