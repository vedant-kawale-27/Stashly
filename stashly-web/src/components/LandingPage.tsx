/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

import React from "react";

interface Props {
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onOpenAuth: (mode?: "login" | "register") => void;
}

export function LandingPage({ theme, onToggleTheme, onOpenAuth }: Props) {
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      {/* Top Navbar */}
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
            </div>
          </div>

          <nav className="header-links">
            <a href="#features" className="header-link-item">Features</a>
            <a href="#architecture" className="header-link-item">Architecture</a>
            <a href="#security" className="header-link-item">Zero-Knowledge E2EE</a>
          </nav>

          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button
              onClick={onToggleTheme}
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

            <button onClick={() => onOpenAuth("register")} className="btn-pill-cyan">
              📱 Pair Phone
            </button>

            <button onClick={() => onOpenAuth("login")} className="btn-primary">
              Login / Portal
            </button>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="hero-wrapper">
        <div className="hero-pill-badge">
          <span className="pulse-dot-green"></span>
          <span>Zero-Knowledge Mobile Cloud Node</span>
        </div>

        <h1 className="hero-title-main">
          Turn Your Phone Into a <br /><span className="gradient-heading">Private Cloud Vault</span>
        </h1>

        <p className="hero-sub-text">
          Access your Android handset storage from any browser worldwide with end-to-end hardware-backed AES-256 encryption. Keep your data under your physical control with zero cloud subscription fees.
        </p>

        <div className="landing-actions">
          <button onClick={() => onOpenAuth("register")} className="btn-primary btn-large">
            Start Free Vault
          </button>
          <button onClick={() => onOpenAuth("login")} className="btn-secondary btn-large">
            Access Dashboard
          </button>
        </div>
      </section>

      {/* Interactive Mockup Dashboard Card */}
      <section className="mockup-wrap">
        <div className="mockup-glass-card">
          <div className="mockup-bar">
            <div className="window-dots-row">
              <span className="dot-c dot-red"></span>
              <span className="dot-c dot-yellow"></span>
              <span className="dot-c dot-green"></span>
            </div>
            <span style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>
              Stashly Node Explorer — Live Stream
            </span>
            <span className="badge-e2e">● WSS Active</span>
          </div>

          <div className="mockup-body-content">
            <div className="metrics-row-3">
              <div className="metric-stat-box">
                <span className="metric-box-label">Connected Node</span>
                <div className="metric-box-val">Pixel 8 Pro</div>
                <span className="metric-box-sub">✓ Online &amp; Live</span>
              </div>
              <div className="metric-stat-box">
                <span className="metric-box-label">Encryption Cipher</span>
                <div className="metric-box-val font-mono">AES-256-GCM</div>
                <span className="metric-box-sub">Hardware Keystore</span>
              </div>
              <div className="metric-stat-box">
                <span className="metric-box-label">Offered Storage</span>
                <div className="metric-box-val font-mono">128 GB</div>
                <span className="metric-box-sub">Local Handset Storage</span>
              </div>
            </div>

            <div className="mockup-file-strip">
              <div className="mockup-file-item">
                <div style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 600 }}>
                  <span>📁</span>
                  <span>/DCIM/Camera/2026/</span>
                </div>
                <span className="badge-e2e">Encrypted</span>
              </div>
              <div className="mockup-file-item">
                <div style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 600 }}>
                  <span>📄</span>
                  <span>financial_report_q3_encrypted.pdf</span>
                </div>
                <span className="badge-e2e">Encrypted</span>
              </div>
              <div className="mockup-file-item">
                <div style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 600 }}>
                  <span>🎬</span>
                  <span>drone_4k_footage_reel.mp4</span>
                </div>
                <span className="badge-e2e">Encrypted</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 3-Column Features Section */}
      <section id="features" className="features-section-box">
        <div className="section-headline-center">
          <span className="section-tag-label">Features &amp; Privacy</span>
          <h2 className="section-title-lg">Built for absolute privacy and high performance</h2>
          <p style={{ color: "var(--text-muted)", fontSize: "1.05rem" }}>
            Traditional clouds read and index your private files. Stashly is architected so even the server cannot read a single byte.
          </p>
        </div>

        <div className="features-grid-3">
          <div className="feature-box-card">
            <div className="feature-box-icon">🔐</div>
            <h3>Zero-Knowledge Architecture</h3>
            <p>
              Files are encrypted locally on your Android handset before transmission. The broker only receives opaque ciphertext blobs.
            </p>
          </div>

          <div className="feature-box-card">
            <div className="feature-box-icon">⚡</div>
            <h3>Direct WebSocket Streaming</h3>
            <p>
              Stream photos, videos, and documents directly from your mobile storage over low-latency persistent channels.
            </p>
          </div>

          <div className="feature-box-card">
            <div className="feature-box-icon">👥</div>
            <h3>Multi-User Phone Sharing</h3>
            <p>
              Connect multiple phones to one account, or grant trusted family and team members access with granular role controls.
            </p>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="landing-footer">
        <div className="landing-footer-inner">
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700 }}>
            <span>Stashly Cloud Vault</span>
          </div>
          <div>
            © {new Date().getFullYear()} Stashly. Free &amp; Open-Source Private Mobile Cloud.
          </div>
        </div>
      </footer>
    </div>
  );
}
