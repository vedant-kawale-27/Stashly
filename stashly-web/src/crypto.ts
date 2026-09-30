/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

// Mirrors the phone app's AesGcm.kt exactly: every blob (wrapped DEKs and
// encrypted file contents) is [12-byte IV][ciphertext][16-byte GCM tag],
// and WebCrypto's AES-GCM decrypt already expects the tag appended to the
// ciphertext, so no extra splitting is needed beyond pulling off the IV.

const IV_LENGTH = 12;

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function importAesKey(rawKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", rawKey as BufferSource, "AES-GCM", false, ["decrypt"]);
}

async function aesGcmDecrypt(rawKey: Uint8Array, blob: ArrayBuffer): Promise<ArrayBuffer> {
  const iv = blob.slice(0, IV_LENGTH);
  const ciphertext = blob.slice(IV_LENGTH);
  const key = await importAesKey(rawKey);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv, tagLength: 128 }, key, ciphertext);
}

/** Unwrap a per-file DEK using the account master key. */
export async function unwrapDek(masterKeyBase64: string, wrappedDekBase64: string): Promise<Uint8Array> {
  const masterKey = base64ToBytes(masterKeyBase64);
  const wrapped = base64ToBytes(wrappedDekBase64).buffer as ArrayBuffer;
  return new Uint8Array(await aesGcmDecrypt(masterKey, wrapped));
}

/** Decrypt a downloaded file's ciphertext using its (already-unwrapped) DEK. */
export async function decryptFile(dek: Uint8Array, ciphertext: ArrayBuffer): Promise<ArrayBuffer> {
  return aesGcmDecrypt(dek, ciphertext);
}
