# NimbusNode Web

React + TypeScript dashboard for the NimbusNode broker: log in, pair new
phones, browse files across devices, and download-and-decrypt them
client-side using the Web Crypto API.

## Setup

```bash
npm install
npm run dev      # http://localhost:5173
```

No `.env` needed — the broker URL is entered in the login screen and saved
to `localStorage`, same as the auth token and (for now) the master key.

## Required broker change

The download endpoint returns the wrapped file key in a custom header
(`X-Encrypted-Dek`). Browsers hide custom response headers from `fetch()`
unless the server explicitly exposes them via CORS. In the broker's
`src/index.ts`:

```ts
app.use(cors({ exposedHeaders: ["X-Encrypted-Dek"] }));
```

Without this, every download will fail with "Broker didn't send
X-Encrypted-Dek" (see `api.ts`'s `downloadFile`).

## How decryption works here

`src/crypto.ts` mirrors the phone app's `AesGcm.kt` format exactly:
`[12-byte IV][ciphertext][16-byte GCM tag]`, for both wrapped DEKs and file
contents. Given the master key, decrypting a downloaded file is:

1. `unwrapDek(masterKey, file.encryptedDek)` → the file's real AES key
2. `decryptFile(dek, ciphertext)` → the plaintext bytes
3. Wrap in a `Blob` and trigger a browser download

## The master key gap (read this before it looks "broken")

There's currently no API call that hands you the master key — it lives
only on paired phones (see the Android project's `KeyManager.kt`). To
decrypt anything here:

1. On the phone app, tap **"Show master key"** — it copies the key to the
   clipboard and displays it on screen.
2. Paste it into this app's **Master key** field.

This manual copy/paste is a placeholder for a real pairing exchange (e.g. a
QR code shown by the phone and scanned by a second device, using ephemeral
Diffie-Hellman so the raw key is never displayed at all). Build that before
this goes anywhere near other people's phones — right now, whoever has the
master key text can decrypt everything, and there's no revocation story if
it leaks.

## What's stubbed / not yet implemented

- **QR-code / secure master-key exchange** (see above) — currently a manual
  paste.
- **Binary framing for large downloads**: matches the broker/phone's
  current base64-in-JSON-over-WebSocket relay, so very large files will be
  slow and memory-hungry until that's upgraded on the broker/phone side.
- **WebDAV / "map network drive" support**: this is the browser-only
  client; the WebDAV translation layer discussed for Windows/macOS mounting
  is a separate piece of the broker, not implemented here.
- **Upload from the browser**: this client only downloads what the phone
  has already synced — it doesn't yet let you push new files back to the
  phone from here.
