/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

import React, { useState } from "react";
import { BrokerClient } from "../api";

interface Props {
  isOpen: boolean;
  initialMode?: "login" | "register";
  client: BrokerClient;
  onClose: () => void;
  onAuthenticated: (token: string, email: string) => void;
}

export function AuthModal({ isOpen, initialMode = "login", client, onClose, onAuthenticated }: Props) {
  const [mode, setMode] = useState<"login" | "register">(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  React.useEffect(() => {
    setMode(initialMode);
    setError(null);
  }, [initialMode, isOpen]);

  if (!isOpen) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!email.trim() || !password) {
      setError("Please fill in both email and password.");
      return;
    }

    if (mode === "register" && password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }

    setLoading(true);
    try {
      let token: string;
      if (mode === "register") {
        token = await client.register(email.trim(), password);
      } else {
        token = await client.login(email.trim(), password);
      }
      onAuthenticated(token, email.trim());
      onClose();
    } catch (err: any) {
      setError(err.message || "Authentication failed. Verify credentials or broker connection.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-overlay-bg" onClick={onClose}>
      <div className="modal-dialog-box" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={onClose}
          style={{
            position: "absolute",
            top: 20,
            right: 20,
            background: "none",
            color: "var(--text-muted)",
            fontSize: "1.1rem"
          }}
          aria-label="Close"
        >
          ✕
        </button>

        <div style={{ textAlign: "center", marginBottom: 20 }}>
          <div className="brand-logo-disc" style={{ margin: "0 auto 12px", width: 44, height: 44 }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <rect width="14" height="20" x="5" y="2" rx="3"/>
              <path d="M12 18h.01"/>
            </svg>
          </div>
          <h3 style={{ fontSize: "1.35rem", fontWeight: 800 }}>
            {mode === "login" ? "Welcome back to Stashly" : "Create Stashly Account"}
          </h3>
          <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginTop: 4 }}>
            {mode === "login" ? "Access your encrypted mobile cloud vault" : "Start your zero-knowledge private mobile node network"}
          </p>
        </div>

        <div style={{ display: "flex", background: "var(--bg-card-subtle)", borderRadius: "var(--radius-full)", padding: 4, marginBottom: 20 }}>
          <button
            type="button"
            style={{
              flex: 1,
              padding: "8px 16px",
              fontSize: "0.88rem",
              fontWeight: 700,
              background: mode === "login" ? "var(--bg-card)" : "transparent",
              color: mode === "login" ? "var(--text-main)" : "var(--text-muted)",
              boxShadow: mode === "login" ? "var(--shadow-sm)" : "none"
            }}
            onClick={() => { setMode("login"); setError(null); }}
          >
            Sign In
          </button>
          <button
            type="button"
            style={{
              flex: 1,
              padding: "8px 16px",
              fontSize: "0.88rem",
              fontWeight: 700,
              background: mode === "register" ? "var(--bg-card)" : "transparent",
              color: mode === "register" ? "var(--text-main)" : "var(--text-muted)",
              boxShadow: mode === "register" ? "var(--shadow-sm)" : "none"
            }}
            onClick={() => { setMode("register"); setError(null); }}
          >
            Register
          </button>
        </div>

        {error && (
          <div style={{
            background: "rgba(239, 68, 68, 0.15)",
            color: "#ef4444",
            padding: "10px 14px",
            borderRadius: "var(--radius-sm)",
            fontSize: "0.85rem",
            fontWeight: 600,
            marginBottom: 16
          }}>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="form-field-wrap">
            <label htmlFor="auth-email">Account Email</label>
            <input
              id="auth-email"
              type="email"
              placeholder="user@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </div>

          <div className="form-field-wrap">
            <label htmlFor="auth-password">Password</label>
            <input
              id="auth-password"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          {mode === "register" && (
            <div className="form-field-wrap">
              <label htmlFor="auth-confirm-password">Confirm Password</label>
              <input
                id="auth-confirm-password"
                type="password"
                placeholder="••••••••"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
              />
            </div>
          )}

          <button
            type="submit"
            className="btn-primary"
            style={{ width: "100%", marginTop: 8, padding: "12px 20px" }}
            disabled={loading}
          >
            {loading ? "Connecting…" : mode === "login" ? "Sign In to Vault" : "Create Free Account"}
          </button>
        </form>

        <div style={{ marginTop: 18, textAlign: "center", fontSize: "0.85rem", color: "var(--text-muted)" }}>
          {mode === "login" ? (
            <p>
              Don't have an account?{" "}
              <button
                type="button"
                onClick={() => setMode("register")}
                style={{ background: "none", color: "var(--primary)", fontWeight: 700, padding: 0 }}
              >
                Sign up free
              </button>
            </p>
          ) : (
            <p>
              Already have an account?{" "}
              <button
                type="button"
                onClick={() => setMode("login")}
                style={{ background: "none", color: "var(--primary)", fontWeight: 700, padding: 0 }}
              >
                Sign in
              </button>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
