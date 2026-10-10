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
  const [mfaChallenge, setMfaChallenge] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState("");

  React.useEffect(() => {
    setMode(initialMode);
    setError(null);
  }, [initialMode, isOpen]);

  async function verifyMfa(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setError(null);
    try { onAuthenticated(await client.verifyMfa(mfaChallenge!, mfaCode), email.trim()); onClose(); }
    catch (err: any) { setError(err.message || "That code is not valid. Try again."); }
    finally { setLoading(false); }
  }

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
        const result = await client.login(email.trim(), password);
        if (!result.token && result.mfaRequired && result.challenge) {
          setMfaChallenge(result.challenge);
          return;
        }
        if (!result.token) throw new Error("Authentication failed");
        token = result.token;
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
    <div className="modal-overlay-bg" onClick={onClose} role="presentation">
      <div className="modal-dialog-box" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close-button" onClick={onClose} aria-label="Close dialog">×</button>

        <div className="auth-heading">
          <div className="brand-logo-disc auth-logo">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <rect width="14" height="20" x="5" y="2" rx="3"/>
              <path d="M12 18h.01"/>
            </svg>
          </div>
          <h3>{mode === "login" ? "Welcome back" : "Create your account"}</h3>
          <p>{mode === "login" ? "Sign in to access your private vault." : "Set up your private phone storage vault."}</p>
        </div>

        <div className="auth-tabs" role="tablist" aria-label="Authentication mode">
          <button
            type="button"
            className={mode === "login" ? "auth-tab active" : "auth-tab"}
            onClick={() => { setMode("login"); setError(null); }}
            role="tab"
            aria-selected={mode === "login"}
          >
            Sign in
          </button>
          <button
            type="button"
            className={mode === "register" ? "auth-tab active" : "auth-tab"}
            onClick={() => { setMode("register"); setError(null); }}
            role="tab"
            aria-selected={mode === "register"}
          >
            Create account
          </button>
        </div>

        {error && <div className="auth-error" role="alert">{error}</div>}

        {mfaChallenge ? <form onSubmit={verifyMfa} className="auth-form">
          <div className="auth-mfa-note">Two-step verification is enabled for this account.</div>
          <div className="form-field-wrap"><label htmlFor="mfa-code">6-digit authenticator code</label><input id="mfa-code" inputMode="numeric" autoComplete="one-time-code" value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} required /></div>
          <button type="submit" className="btn-primary auth-submit" disabled={loading}>{loading ? "Checking code…" : "Verify and sign in"}</button>
        </form> : <form onSubmit={handleSubmit}>
          <div className="form-field-wrap">
            <label htmlFor="auth-email">Email address</label>
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
              <label htmlFor="auth-confirm-password">Confirm password</label>
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
            className="btn-primary auth-submit"
            disabled={loading}
          >
            {loading ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>}

        <div className="auth-footer">
          {mode === "login" ? (
            <p>
              Don't have an account?{" "}
              <button
                type="button"
                onClick={() => setMode("register")}
                className="auth-link-button"
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
                className="auth-link-button"
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
