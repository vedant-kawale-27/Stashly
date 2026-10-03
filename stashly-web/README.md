# Stashly Web Dashboard

Stashly Web is a single-page web application that provides complete cloud storage exploration, node lifecycle management, zero-knowledge in-browser decryption, and pairing controls for the Stashly storage ecosystem.

The web client operates entirely under a zero-trust model: encrypted ciphertexts downloaded from the broker are decrypted directly inside the user's browser memory using the W3C Web Crypto API. The broker never receives or holds the master key.

## Current capabilities

- QR and manual device pairing with device selection and live presence
- File browsing, previews, downloads, uploads, and scoped access controls
- Metadata-first browsing, encrypted thumbnails, and progressive image previews
- Chunked large-file downloads with binary encrypted frames and chunk-aligned ranges
- Per-device master-key storage in local browser storage, with optional
  Bluetooth transfer from the Android node on supported browsers
- Encrypted IndexedDB offline downloads containing ciphertext and wrapped DEKs
- Share-link creation/revocation, password changes, authenticator-app MFA,
  dark mode and local security-data clearing
- Installable PWA assets and responsive desktop/mobile layouts

---

## Technical Specifications

- **Framework**: React 18 (Hooks, functional components)
- **Language**: TypeScript (Strict Mode)
- **Build Tooling**: Vite 5.x
- **Styling Architecture**: Vanilla CSS with custom CSS Variables, responsive grid layouts, and glassmorphism styling tokens
- **Cryptography Engine**: Native Web Crypto API (`window.crypto.subtle`)
- **QR Code Engine**: `qrcode.react` (SVG-based barcode rendering)

---

## Client-Side Cryptography Pipeline (`src/crypto.ts`)

The web client implements the exact cryptographic counterpart to the Android app's `AesGcm.kt`:

1. **Master Key Ingestion**:
   - The user inputs the 32-byte Base64-encoded Master Key obtained from their Android storage node.
   - Decoded into a 32-byte `Uint8Array` using `base64ToBytes()`.

2. **DEK Unwrapping (`unwrapDek`)**:
   - When a file is requested, the broker returns the `X-Encrypted-Dek` HTTP response header.
   - The wrapped DEK blob is sliced into:
     - `IV`: First 12 bytes (`blob.slice(0, 12)`).
     - `Ciphertext + Tag`: Remaining bytes (`blob.slice(12)`).
   - The master key is imported via `crypto.subtle.importKey("raw", masterKey, "AES-GCM", false, ["decrypt"])`.
   - The per-file 256-bit AES-GCM data key (DEK) is decrypted in memory.

3. **File Decryption (`decryptFile`)**:
   - The encrypted file payload is downloaded as an `ArrayBuffer`.
   - The DEK is imported as an AES-GCM CryptoKey.
   - The ciphertext is decrypted using `crypto.subtle.decrypt({ name: "AES-GCM", iv, tagLength: 128 }, key, ciphertext)`.
   - The decrypted `ArrayBuffer` is wrapped into a browser `Blob` matching the file's MIME type and saved or opened via an object URL (`URL.createObjectURL(blob)`).

4. **Chunked Decryption (`decryptChunkedFile`)**:
   - Large-file responses contain a count followed by length-prefixed encrypted
     chunks.
   - Each chunk has its own IV and GCM authentication tag and is authenticated
     before being joined for a preview.
   - Direct downloads can use the File System Access API to decrypt and write
     one chunk at a time, avoiding a full-file browser buffer.

---

## Component Architecture

### 1. `App.tsx` (Application Root and State Coordinator)
- Manages authentication state, active session token, active user email, and theme selection (`light` / `dark`).
- Automatically maintains master keys per connected device (`stashly_master_keys` in `localStorage`).
- Executes a 15-second heartbeat loop to `/devices/presence` to inform connected mobile nodes that the web client is actively viewing the console.

### 2. `LandingPage.tsx`
- Modern introductory portal for unauthenticated visitors.
- Highlights zero-knowledge privacy features, hardware Keystore security, and multi-device capabilities.
- Direct triggers for the sign-in / registration modal.

### 3. `AuthModal.tsx`
- Unified modal dialog for user registration and login.
- Handles input validation, password confirmation, error states, and token storage.

### 4. `PairingPanel.tsx`
- Dynamic Broker URL Detection: Queries the broker's `/info` endpoint to detect local network IP addresses or public domains for reliable mobile reachability.
- QR Code Generation: Generates standard JSON payloads (`{"type": "stashly_pair", "brokerUrl": "...", "token": "..."}`) for 1-tap scanning with the Android app.
- Manual Code Display: Renders the 8-character pairing code with 1-click clipboard copying.

### 5. `DeviceList.tsx`
- Lists all connected storage nodes with real-time status indicators (Live Stream vs Offline).
- Displays individual client permissions, connection dates, and last seen timestamps.
- Features in-place node renaming, storage quota visualization, and connection removal actions.
- Launches the Windows Drive Mount helper.

### 6. `FileBrowser.tsx`
- Hierarchical file manager with breadcrumb navigation and path filtering.
- Master Key Management Drawer: Allows users to input, toggle visibility, and validate their master key against active files before attempting downloads.
- Asynchronous file previewing and downloads with progress indicators and error normalization (e.g., handling offline nodes without cached copies).

### 7. `WindowsMountModal.tsx`
- Provides step-by-step PowerShell scripts and WebDAV connection instructions to mount the Android storage node as a Windows mapped network drive (`Z:`).

### 8. Device, settings, and offline features
- `DevicePicker.tsx` keeps file operations tied to an explicitly selected node.
- `SettingsPage.tsx` manages passwords, TOTP MFA, and local-data clearing
  locally stored keys/ciphertext.
- `BluetoothKeyModal.tsx` uses Web Bluetooth to receive a master key from the
  Android node when the browser and device support the protocol.
- `offlineCache.ts` stores broker ciphertext and wrapped DEKs in IndexedDB;
  plaintext is produced only for an explicit preview or download.
- `public/manifest.webmanifest` and `public/sw.js`
  provide optional browser alerts and installable PWA support.

---

## API Client Architecture (`src/api.ts`)

The `BrokerClient` class encapsulates all communication with the broker server:

- **Authentication Headers**: Injects `Authorization: Bearer <token>` automatically on authenticated requests.
- **Header Parsing**: Extracts `X-Encrypted-Dek` and `X-From-Local-Cache` from download responses.
- **Error Normalization**: Maps HTTP status codes (e.g., 401, 404, 503) and broker error codes (`DEVICE_OFFLINE_NO_CACHE`, `DEVICE_TIMEOUT_NO_CACHE`) to structured `ApiError` instances.
- **Chunk Streaming**: `streamDownloadChunked()` parses framed encrypted chunks
  as they arrive and can pass each chunk to a local file sink. The browser
  validates the end marker and chunk boundaries before accepting the stream.
- **Live Thumbnails**: Thumbnail responses are decrypted in memory and are not
  persisted as plaintext browser data.

---

## Development and Build Setup

### Install Dependencies
```bash
npm install
```

### Start Development Server
```bash
npm run dev
```

### Build Production Bundle
```bash
npm run build
```
The compiled static assets will be output to the `dist/` directory, ready for deployment to any static web host or CDN (Vercel, Netlify, Cloudflare Pages, Nginx, or AWS S3).

### Environment

Create `.env` from `.env.example` when needed:

```ini
VITE_BROKER_URL=http://localhost:4000
```
