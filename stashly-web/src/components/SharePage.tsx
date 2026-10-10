/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

import { useEffect, useState } from "react";
import { decryptFile, base64ToBytes } from "../crypto";

interface Props {
  brokerUrl: string;
  token: string;
}

interface ShareMetadata {
  file: { name: string; sizeBytes: number; mimeType: string | null };
  expiresAt: string;
}

export function SharePage({ brokerUrl, token }: Props) {
  const [metadata, setMetadata] = useState<ShareMetadata | null>(null);
  const [plaintext, setPlaintext] = useState<ArrayBuffer | null>(null);
  const [status, setStatus] = useState("Loading shared file...");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const encodedDek = new URLSearchParams(window.location.hash.slice(1)).get("dek");
        if (!encodedDek) throw new Error("This share link is missing its decryption key.");
        const dek = base64ToBytes(encodedDek);
        if (dek.byteLength !== 32) throw new Error("This share link contains an invalid decryption key.");
        const base = brokerUrl.replace(/\/+$/, "");
        const metadataResponse = await fetch(`${base}/share/${encodeURIComponent(token)}`);
        if (!metadataResponse.ok) throw new Error("This share link is invalid, expired, or revoked.");
        const nextMetadata = await metadataResponse.json() as ShareMetadata;
        const downloadResponse = await fetch(`${base}/share/${encodeURIComponent(token)}/download`);
        if (!downloadResponse.ok) throw new Error((await downloadResponse.json().catch(() => null))?.error ?? "The shared file is unavailable.");
        const ciphertext = await downloadResponse.arrayBuffer();
        const nextPlaintext = await decryptFile(dek, ciphertext);
        if (active) {
          setMetadata(nextMetadata);
          setPlaintext(nextPlaintext);
          setStatus("Ready to download");
        }
      } catch (cause) {
        if (active) {
          setError(cause instanceof Error ? cause.message : "Unable to open this share link.");
          setStatus("");
        }
      }
    }
    void load();
    return () => { active = false; };
  }, [brokerUrl, token]);

  function download() {
    if (!metadata || !plaintext) return;
    const url = URL.createObjectURL(new Blob([plaintext], { type: metadata.file.mimeType ?? "application/octet-stream" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = metadata.file.name;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="page-view share-page">
      <span className="eyebrow">Stashly shared file</span>
      <h1>{metadata?.file.name ?? "Shared file"}</h1>
      {status && <p>{status}</p>}
      {error && <p className="share-page-error">{error}</p>}
      {metadata && plaintext && (
        <button className="btn-primary" type="button" onClick={download}>Download {metadata.file.name}</button>
      )}
    </main>
  );
}
