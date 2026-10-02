/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

import React, { useState, useRef, useCallback } from "react";

// ── BLE GATT UUIDs (must match Android BleKeyShareServer) ──────────────
const STASHLY_SERVICE_UUID       = "0000ff01-0000-1000-8000-00805f9b34fb";
const CHAR_ECDH_PUB_UUID         = "0000ff02-0000-1000-8000-00805f9b34fb";
const CHAR_ENCRYPTED_KEY_UUID    = "0000ff03-0000-1000-8000-00805f9b34fb";
const CHAR_PIN_CONFIRM_UUID      = "0000ff04-0000-1000-8000-00805f9b34fb";

type Phase =
  | "idle"
  | "scanning"
  | "connecting"
  | "exchanging"
  | "pin_confirm"
  | "receiving"
  | "success"
  | "error";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onKeyReceived: (masterKeyBase64: string) => void;
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Derive a 6-digit confirmation PIN from the ECDH shared secret.
 * Must produce the same result as BleKeyShareServer.derivePinFromSecret():
 *   SHA-256(sharedSecret) → first 4 bytes as big-endian uint32 → mod 1_000_000
 */
async function derivePinFromSecret(sharedSecret: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", sharedSecret);
  const view = new DataView(hash);
  // getUint32 with big-endian (false) returns unsigned 0..4294967295
  const num = view.getUint32(0, false) % 1000000;
  return num.toString().padStart(6, "0");
}

/**
 * Safely extract a proper ArrayBuffer from a DataView, handling possible
 * byteOffset issues (some BLE stacks return DataViews with non-zero offsets).
 */
function dataViewToArrayBuffer(dv: DataView): ArrayBuffer {
  return dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength) as ArrayBuffer;
}


export function BluetoothKeyModal({ isOpen, onClose, onKeyReceived }: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [deviceName, setDeviceName] = useState<string>("");
  const [pin, setPin] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [statusText, setStatusText] = useState<string>("");

  const gattServerRef = useRef<BluetoothRemoteGATTServer | null>(null);
  const bleDeviceRef = useRef<BluetoothDevice | null>(null);
  // Persist the ECDH shared secret across phases so confirmPin() can work
  // without re-generating the keypair.
  const sharedSecretRef = useRef<ArrayBuffer | null>(null);

  const cleanup = useCallback(() => {
    try {
      if (gattServerRef.current?.connected) {
        gattServerRef.current.disconnect();
      }
    } catch (_) { /* ignore */ }
    gattServerRef.current = null;
    bleDeviceRef.current = null;
    sharedSecretRef.current = null;
  }, []);

  const handleClose = useCallback(() => {
    cleanup();
    setPhase("idle");
    setDeviceName("");
    setPin("");
    setError("");
    setStatusText("");
    onClose();
  }, [cleanup, onClose]);

  async function startBluetoothFlow() {
    // Check Web Bluetooth API support
    if (!navigator.bluetooth) {
      setPhase("error");
      setError(
        "Web Bluetooth is not supported in this browser. Use Chrome, Edge, or Opera on a desktop/Android device."
      );
      return;
    }

    try {
      // ── Phase 1: Scan for the Stashly BLE device ─────────────────────
      setPhase("scanning");
      setStatusText("Searching for nearby Stashly devices...");
      setError("");

      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [STASHLY_SERVICE_UUID] }],
        optionalServices: [STASHLY_SERVICE_UUID],
      });

      if (!device) {
        setPhase("idle");
        return;
      }

      bleDeviceRef.current = device;
      setDeviceName(device.name || "Stashly Device");

      // ── Phase 2: Connect GATT ────────────────────────────────────────
      setPhase("connecting");
      setStatusText(`Connecting to ${device.name || "device"}...`);

      const server = await device.gatt!.connect();
      gattServerRef.current = server;

      // ── Phase 3: ECDH Key Exchange ───────────────────────────────────
      setPhase("exchanging");
      setStatusText("Performing secure key exchange...");

      const service = await server.getPrimaryService(STASHLY_SERVICE_UUID);
      const ecdhPubChar = await service.getCharacteristic(CHAR_ECDH_PUB_UUID);

      // Generate our ECDH key pair
      const webKeyPair = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        false, // non-extractable is fine; we only need deriveBits
        ["deriveBits"]
      );

      // Read the Android device's ECDH public key (65 bytes uncompressed)
      const androidPubKeyDV = await ecdhPubChar.readValue();
      const androidPubKeyBuffer = dataViewToArrayBuffer(androidPubKeyDV);

      // Import Android's public key for ECDH
      const androidPubKey = await crypto.subtle.importKey(
        "raw",
        androidPubKeyBuffer,
        { name: "ECDH", namedCurve: "P-256" },
        false,
        []
      );

      // Export our public key (uncompressed point, 65 bytes for P-256)
      const webPubKeyRaw = await crypto.subtle.exportKey("raw", webKeyPair.publicKey);

      // Write our public key to the Android device
      // 65 bytes fits well within BLE's 512-byte write limit
      await ecdhPubChar.writeValue(new Uint8Array(webPubKeyRaw));

      // Derive shared secret (256 bits = 32 bytes)
      const sharedSecret = await crypto.subtle.deriveBits(
        { name: "ECDH", public: androidPubKey },
        webKeyPair.privateKey,
        256
      );

      // Store the shared secret so confirmPin() doesn't need the keypair
      sharedSecretRef.current = sharedSecret;

      // ── Phase 4: PIN Confirmation ────────────────────────────────────
      const derivedPin = await derivePinFromSecret(sharedSecret);
      setPin(derivedPin);
      setPhase("pin_confirm");
      setStatusText("Confirm this PIN matches the one shown on your phone.");

    } catch (err: any) {
      if (err.name === "NotFoundError" || err.code === 8) {
        // User cancelled the device chooser
        setPhase("idle");
        return;
      }
      setPhase("error");
      setError(err.message || "Bluetooth connection failed.");
      cleanup();
    }
  }

  async function confirmPin() {
    try {
      setPhase("receiving");
      setStatusText("Receiving master key...");

      const server = gattServerRef.current;
      if (!server?.connected) {
        throw new Error("BLE connection lost. Please try again.");
      }

      const service = await server.getPrimaryService(STASHLY_SERVICE_UUID);
      const pinConfirmChar = await service.getCharacteristic(CHAR_PIN_CONFIRM_UUID);
      const encryptedKeyChar = await service.getCharacteristic(CHAR_ENCRYPTED_KEY_UUID);

      // Tell the Android device we confirmed the PIN
      await pinConfirmChar.writeValue(new Uint8Array([1]));

      // Small delay to let Android process the PIN confirmation before we read
      await new Promise((r) => setTimeout(r, 200));

      // Read the master key from the characteristic
      // Android sends it as raw UTF-8 Base64 text after PIN confirmation
      const keyDataDV = await encryptedKeyChar.readValue();
      const keyBuffer = dataViewToArrayBuffer(keyDataDV);

      // Decode the received data as UTF-8 Base64 master key
      const decoder = new TextDecoder("utf-8");
      const masterKeyBase64 = decoder.decode(keyBuffer).trim();

      if (!masterKeyBase64 || masterKeyBase64.length < 10) {
        throw new Error("Received invalid key data from device.");
      }

      // Validate it's a proper 32-byte base64 key
      try {
        const decoded = atob(masterKeyBase64);
        if (decoded.length !== 32) {
          throw new Error(`Key is ${decoded.length} bytes, expected 32 bytes (AES-256).`);
        }
      } catch (e: any) {
        if (e.message.includes("bytes")) throw e;
        throw new Error("Invalid Base64 key received: " + e.message);
      }

      setPhase("success");
      setStatusText("Master key received successfully!");
      onKeyReceived(masterKeyBase64);

      // Auto-disconnect after a short delay
      setTimeout(() => {
        cleanup();
      }, 1000);

    } catch (err: any) {
      setPhase("error");
      setError(err.message || "Failed to receive master key.");
      cleanup();
    }
  }

  function rejectPin() {
    cleanup();
    setPhase("idle");
    setPin("");
    setStatusText("");
  }

  if (!isOpen) return null;

  return (
    <div className="modal-overlay-bg" onClick={handleClose}>
      <div
        className="modal-dialog-box"
        style={{ maxWidth: 520 }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close Button */}
        <button
          onClick={handleClose}
          style={{
            position: "absolute",
            top: 16,
            right: 16,
            background: "none",
            color: "var(--text-muted)",
            fontSize: "1.1rem",
            cursor: "pointer",
            border: "none",
          }}
          aria-label="Close"
        >
          ✕
        </button>

        {/* Header */}
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: "50%",
              background: "var(--primary-gradient)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "0 auto 12px",
            }}
          >
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6.5 6.5 17.5 17.5 12 23l-1.5-1.5L15 17l-3-3-4.5 4.5L6 17l4.5-4.5-3-3-4.5 4.5L1.5 12 6.5 6.5z"/>
              <path d="m14 7 3 3"/>
              <path d="M17 3l4 4-3.5 3.5"/>
            </svg>
          </div>
          <h3 style={{ fontSize: "1.3rem", fontWeight: 800, color: "var(--text-main)" }}>
            Bluetooth Key Transfer
          </h3>
          <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginTop: 4 }}>
            Securely receive your master key from a nearby Stashly Android device
          </p>
        </div>

        {/* ── Idle State ─────────────────────────────────────────────── */}
        {phase === "idle" && (
          <div style={{ textAlign: "center" }}>
            <div style={{
              background: "var(--bg-card-subtle)",
              borderRadius: "var(--radius-md)",
              padding: "20px",
              marginBottom: 20,
            }}>
              <div style={{ fontSize: "0.85rem", color: "var(--text-sub)", lineHeight: 1.6 }}>
                <strong>How it works:</strong>
                <ol style={{ textAlign: "left", paddingLeft: 20, marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                  <li>Open your Stashly app on your Android phone</li>
                  <li>Go to Settings and tap <strong>"Master Key Options"</strong></li>
                  <li>Select <strong>"Share via Bluetooth"</strong></li>
                  <li>Click the button below to scan for your device</li>
                  <li>Verify the confirmation PIN on both devices</li>
                </ol>
              </div>
            </div>
            <button
              className="btn-primary"
              style={{ width: "100%", padding: "14px 20px", fontSize: "1rem", fontWeight: 700 }}
              onClick={startBluetoothFlow}
            >
              <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6.5 6.5 17.5 17.5 12 23l-1.5-1.5L15 17l-3-3-4.5 4.5L6 17l4.5-4.5-3-3-4.5 4.5L1.5 12 6.5 6.5z"/>
                  <path d="m14 7 3 3"/>
                  <path d="M17 3l4 4-3.5 3.5"/>
                </svg>
                Scan for Nearby Devices
              </span>
            </button>
          </div>
        )}

        {/* ── Scanning / Connecting / Exchanging ─────────────────────── */}
        {(phase === "scanning" || phase === "connecting" || phase === "exchanging" || phase === "receiving") && (
          <div style={{ textAlign: "center", padding: "20px 0" }}>
            <div className="ble-pulse-ring" style={{ margin: "0 auto 20px" }}>
              <div className="ble-pulse-dot" />
            </div>
            <p style={{ fontSize: "0.95rem", fontWeight: 600, color: "var(--text-main)", marginBottom: 6 }}>
              {deviceName ? `${deviceName}` : "Searching..."}
            </p>
            <p style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
              {statusText}
            </p>
          </div>
        )}

        {/* ── PIN Confirmation ───────────────────────────────────────── */}
        {phase === "pin_confirm" && (
          <div style={{ textAlign: "center" }}>
            <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginBottom: 16 }}>
              Verify this PIN matches the one displayed on <strong>{deviceName}</strong>
            </p>

            <div style={{
              display: "flex",
              justifyContent: "center",
              gap: 8,
              marginBottom: 24,
            }}>
              {pin.split("").map((digit, i) => (
                <div
                  key={i}
                  style={{
                    width: 48,
                    height: 56,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "1.6rem",
                    fontWeight: 800,
                    fontFamily: "var(--font-mono)",
                    background: "var(--bg-card-subtle)",
                    border: "2px solid var(--border-focus)",
                    borderRadius: "var(--radius-md)",
                    color: "var(--primary)",
                    boxShadow: "0 0 0 3px var(--border-accent)",
                  }}
                >
                  {digit}
                </div>
              ))}
            </div>

            <div style={{
              background: "rgba(245, 158, 11, 0.1)",
              border: "1px solid rgba(245, 158, 11, 0.3)",
              borderRadius: "var(--radius-sm)",
              padding: "10px 14px",
              marginBottom: 20,
              fontSize: "0.82rem",
              color: "#f59e0b",
            }}>
              If the PINs do not match, tap Reject to cancel the transfer.
            </div>

            <div style={{ display: "flex", gap: 12 }}>
              <button
                className="btn-secondary"
                style={{ flex: 1, padding: "12px 16px", fontWeight: 700 }}
                onClick={rejectPin}
              >
                Reject
              </button>
              <button
                className="btn-primary"
                style={{ flex: 2, padding: "12px 16px", fontWeight: 700 }}
                onClick={confirmPin}
              >
                <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  PINs Match - Confirm
                </span>
              </button>
            </div>
          </div>
        )}

        {/* ── Success ────────────────────────────────────────────────── */}
        {phase === "success" && (
          <div style={{ textAlign: "center", padding: "20px 0" }}>
            <div style={{
              width: 64,
              height: 64,
              borderRadius: "50%",
              background: "rgba(16, 185, 129, 0.15)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "0 auto 16px",
              animation: "popIn 0.3s ease-out",
            }}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
            </div>
            <h4 style={{ fontSize: "1.15rem", fontWeight: 800, color: "#10b981", marginBottom: 8 }}>
              Key Transferred Successfully
            </h4>
            <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginBottom: 20 }}>
              Your master key has been securely received from <strong>{deviceName}</strong> and saved to this browser.
            </p>
            <button
              className="btn-primary"
              style={{ padding: "12px 32px", fontWeight: 700 }}
              onClick={handleClose}
            >
              Done
            </button>
          </div>
        )}

        {/* ── Error ──────────────────────────────────────────────────── */}
        {phase === "error" && (
          <div style={{ textAlign: "center", padding: "10px 0" }}>
            <div style={{
              width: 64,
              height: 64,
              borderRadius: "50%",
              background: "rgba(239, 68, 68, 0.12)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "0 auto 16px",
            }}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
            </div>
            <h4 style={{ fontSize: "1rem", fontWeight: 700, color: "#ef4444", marginBottom: 8 }}>
              Transfer Failed
            </h4>
            <p style={{
              fontSize: "0.85rem",
              color: "var(--text-muted)",
              marginBottom: 20,
              background: "rgba(239, 68, 68, 0.08)",
              padding: "10px 14px",
              borderRadius: "var(--radius-sm)",
            }}>
              {error}
            </p>
            <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
              <button
                className="btn-secondary"
                style={{ padding: "10px 20px", fontWeight: 600 }}
                onClick={handleClose}
              >
                Cancel
              </button>
              <button
                className="btn-primary"
                style={{ padding: "10px 20px", fontWeight: 600 }}
                onClick={() => {
                  setPhase("idle");
                  setError("");
                }}
              >
                Try Again
              </button>
            </div>
          </div>
        )}

        {/* ── Footer security note ───────────────────────────────────── */}
        <div style={{
          marginTop: 20,
          paddingTop: 16,
          borderTop: "1px solid var(--border-subtle)",
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: "0.75rem",
          color: "var(--text-muted)",
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <span>End-to-end encrypted via BLE GATT with ECDH P-256 key agreement</span>
        </div>
      </div>
    </div>
  );
}
