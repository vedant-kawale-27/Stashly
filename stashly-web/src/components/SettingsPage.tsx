/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

import { FormEvent, useEffect, useState } from "react";
import { BrokerClient } from "../api";

interface Props {
  client: BrokerClient;
  email: string;
  onLogout: () => void;
  onClearLocalKeyData: () => Promise<void>;
}

export function SettingsPage({ client, email, onLogout, onClearLocalKeyData }: Props) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [mfaEnabled, setMfaEnabled] = useState(false);
  const [mfaSecret, setMfaSecret] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  useEffect(() => { void client.mfaStatus().then(setMfaEnabled).catch(() => {}); }, [client]);

  async function handlePasswordChange(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    setError(null);
    if (newPassword.length < 6) return setError("Use at least 6 characters for the new password.");
    if (newPassword !== confirmPassword) return setError("The new passwords do not match.");
    setSaving(true);
    try {
      await client.changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setMessage("Password updated successfully.");
    } catch (err: any) {
      setError(err.message ?? "Could not update password.");
    } finally {
      setSaving(false);
    }
  }

  async function clearBrowserData() {
    if (!confirm("Clear saved master keys and browser cache? Your account and phone data will remain.")) return;
    await onClearLocalKeyData();
    setMessage("Saved browser keys and cache were cleared.");
  }

  async function setupMfa() {
    setError(null);
    try { const setup = await client.beginMfaSetup(); setMfaSecret(setup.secret); }
    catch (err: any) { setError(err.message ?? "Could not start MFA setup."); }
  }
  async function confirmMfa() {
    try { await client.confirmMfa(mfaCode); setMfaEnabled(true); setMfaSecret(""); setMfaCode(""); setMessage("MFA enabled."); }
    catch (err: any) { setError(err.message ?? "Invalid authenticator code."); }
  }
  async function disableMfa() {
    try { await client.disableMfa(mfaCode); setMfaEnabled(false); setMfaCode(""); setMessage("MFA disabled."); }
    catch (err: any) { setError(err.message ?? "Invalid authenticator code."); }
  }

  return (
    <div className="settings-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Account</span>
          <h1>Settings</h1>
          <p>Manage your Stashly profile and browser security.</p>
        </div>
      </div>

      <div className="settings-grid">
        <section className="settings-card">
          <div className="settings-card-heading"><span className="settings-icon">@</span><div><h2>Profile</h2><p>Your signed-in account</p></div></div>
          <div className="profile-row"><div className="profile-avatar">{email[0]?.toUpperCase() ?? "U"}</div><div><strong>{email}</strong><span>Stashly account</span></div></div>
          <button className="btn-secondary" onClick={onLogout}>Sign out</button>
        </section>

        <section className="settings-card">
          <div className="settings-card-heading"><span className="settings-icon">#</span><div><h2>Authenticator MFA</h2><p>Protect sign-in with a TOTP code</p></div></div>
          {mfaEnabled ? <><p className="settings-copy">MFA is enabled. Enter a current authenticator code to disable it.</p><input inputMode="numeric" placeholder="6-digit code" value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} /><button className="btn-secondary danger-button" onClick={() => void disableMfa()}>Disable MFA</button></> :
            <>{mfaSecret ? <><p className="settings-copy">Add this secret to an authenticator app, then verify it. <strong>{mfaSecret}</strong></p><input inputMode="numeric" placeholder="6-digit code" value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} /><button className="btn-primary" onClick={() => void confirmMfa()}>Enable MFA</button></> : <button className="btn-secondary" onClick={() => void setupMfa()}>Set up authenticator</button>}</>}
        </section>

        <section className="settings-card">
          <div className="settings-card-heading"><span className="settings-icon">*</span><div><h2>Change password</h2><p>Keep your account protected</p></div></div>
          <form onSubmit={handlePasswordChange}>
            <div className="form-field-wrap"><label htmlFor="current-password">Current password</label><input id="current-password" type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required /></div>
            <div className="form-field-wrap"><label htmlFor="new-password">New password</label><input id="new-password" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} minLength={6} required /></div>
            <div className="form-field-wrap"><label htmlFor="confirm-new-password">Confirm new password</label><input id="confirm-new-password" type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} minLength={6} required /></div>
            {error && <div className="settings-message settings-error">{error}</div>}
            {message && <div className="settings-message settings-success">{message}</div>}
            <button className="btn-primary" type="submit" disabled={saving}>{saving ? "Updating..." : "Update password"}</button>
          </form>
        </section>

        <section className="settings-card">
          <div className="settings-card-heading"><span className="settings-icon">~</span><div><h2>Browser security</h2><p>Local-only key material and cache</p></div></div>
          <p className="settings-copy">Master keys are kept in this browser for the selected nodes. Clearing browser data does not delete files, devices, or your account.</p>
          <button className="btn-secondary danger-button" onClick={() => void clearBrowserData()}>Clear saved keys and cache</button>
        </section>

      </div>
    </div>
  );
}
