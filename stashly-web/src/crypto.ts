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

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 32768;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

async function importAesKey(rawKey: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", rawKey as BufferSource, "AES-GCM", false, usages);
}

async function aesGcmDecrypt(rawKey: Uint8Array, blob: ArrayBuffer): Promise<ArrayBuffer> {
  if (blob.byteLength < IV_LENGTH + 16) {
    throw new Error("Ciphertext blob is too short (corrupted or incomplete)");
  }
  const iv = blob.slice(0, IV_LENGTH);
  const ciphertext = blob.slice(IV_LENGTH);
  const key = await importAesKey(rawKey, ["decrypt"]);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv, tagLength: 128 }, key, ciphertext);
}

async function aesGcmEncrypt(rawKey: Uint8Array, plaintext: ArrayBuffer): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const key = await importAesKey(rawKey, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, tagLength: 128 }, key, plaintext);
  const result = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), IV_LENGTH);
  return result.buffer;
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

/** Encrypt a file with a fresh per-file data key. */
export async function encryptFile(plaintext: ArrayBuffer): Promise<{ ciphertext: ArrayBuffer; dek: Uint8Array }> {
  const dek = crypto.getRandomValues(new Uint8Array(32));
  return { ciphertext: await aesGcmEncrypt(dek, plaintext), dek };
}

/** Wrap a per-file data key with the device master key. */
export async function wrapDek(masterKeyBase64: string, dek: Uint8Array): Promise<string> {
  const dekBuffer = dek.buffer.slice(dek.byteOffset, dek.byteOffset + dek.byteLength) as ArrayBuffer;
  const wrapped = await aesGcmEncrypt(base64ToBytes(masterKeyBase64), dekBuffer);
  return bytesToBase64(new Uint8Array(wrapped));
}
