import React, { useState } from "react";
import { Device } from "../api";

interface Props {
  device: Device;
  brokerUrl: string;
  token: string;
  onClose: () => void;
}

export function WindowsMountModal({ device, brokerUrl, token, onClose }: Props) {
  const [copied, setCopied] = useState(false);
  const mountScript = `# 1. Stashly CLI Virtual Drive Mount Command
stashly-mount --broker="${brokerUrl}" --device="${device.id}" --token="${token}" --drive=Z:

# 2. Or map via WebDAV in Windows Explorer:
# Address: http://localhost:8080/webdav
# Drive Letter: Z:\\`;

  function handleCopy() {
    navigator.clipboard.writeText(mountScript);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog-content" onClick={(e) => e.stopPropagation()}>
        <button className="dialog-close-btn" onClick={onClose} aria-label="Close">
          ✕
        </button>

        <div style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: "1.1rem", fontWeight: 700 }}>Mount Node as Native Drive (Z:\)</h3>
          <p style={{ fontSize: "0.82rem", color: "var(--text-secondary)", marginTop: 2 }}>
            Map {device.name} directly into Windows File Explorer for streaming access.
          </p>
        </div>

        <div
          className="font-mono"
          style={{
            backgroundColor: "var(--bg-subtle)",
            border: "1px solid var(--border-default)",
            borderRadius: "var(--radius-xs)",
            padding: "12px",
            fontSize: "0.78rem",
            color: "var(--text-primary)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            marginBottom: 16
          }}
        >
          {mountScript}
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <button className="btn-secondary btn-subtle" onClick={handleCopy}>
            {copied ? "✓ Copied" : "Copy Command"}
          </button>
          <button className="btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
