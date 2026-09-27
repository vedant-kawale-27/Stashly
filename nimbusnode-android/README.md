# NimbusNode Android (storage node app)

Turns this phone into a reachable storage node for the NimbusNode broker:
a foreground service holds one persistent WebSocket connection to the
broker, so the phone stays reachable for file requests without needing a
public IP or to be physically nearby — it always dials *out*.

## Open in Android Studio

Open this folder directly (Android Studio will generate the Gradle
wrapper on first sync if it's missing). Requires JDK 17 and Android SDK 34.

## How it fits with the broker

Matches the protocol in the broker's `src/ws/deviceHub.ts` exactly:

- **Pairing**: `MainActivity` → `PairingRepository.pair()` → `POST /devices/pair`
  with the code shown on the web dashboard → gets back `deviceId` +
  `deviceToken`, stored in `SecureStorage` (Keystore-backed
  `EncryptedSharedPreferences`).
- **Connection**: `StorageNodeService` starts as soon as pairing succeeds
  (and again on boot, via `BootReceiver`) and hands off to
  `BrokerSocketClient`, which opens `wss://<broker>/ws/device?token=<deviceToken>`,
  sends `hello` + an initial `file_sync`, and replies to `fetch_request`
  messages with `fetch_result`.
- **Reconnects**: capped exponential backoff on drop, plus an immediate
  retry whenever `ConnectivityManager` reports the network came back.

## Encryption

- `FileVault` encrypts each file in the exposed folder with its own random
  AES-256-GCM **DEK**, caches the ciphertext locally, and reports its hash +
  a **wrapped DEK** to the broker — the broker only ever sees ciphertext and
  an opaque wrapped key, never plaintext or the raw key.
- `KeyManager` holds the account **master key** used to wrap/unwrap DEKs.

**Known limitation, called out in `KeyManager`'s doc comment**: this
skeleton only stores the master key locally on this phone. It does *not*
yet implement secure export to other client devices (web dashboard, a
mapped Windows drive) — that needs a real pairing/key-exchange flow (e.g.
QR-code transfer via ephemeral Diffie-Hellman) before those clients can
decrypt anything this phone encrypts. Build that before wiring up the web
client's decryption path.

## What's stubbed / not yet implemented

- **Choosing which folder to expose**: files currently must be manually
  copied into `Android/data/com.nimbusnode.app/files/vault` on the device.
  Swap `FileVault.vaultDir` for a Storage Access Framework folder picker to
  let users expose an existing folder (e.g. Camera/DCIM) instead.
- **Binary framing**: like the broker, file transfer is base64-in-JSON for
  simplicity. Move to raw binary WS frames before pushing large files.
- **Triggering re-sync on file changes**: `pushFileSync()` currently only
  runs on connect. Add a `FileObserver` (or a periodic `WorkManager` job) on
  `vaultDir` to push updates as files are added/changed without needing a
  reconnect.
- **Multi-device master key export** — see above.
- **Cellular data controls**: no Wi-Fi-only mode yet; add a
  `ConnectivityManager.NetworkCapabilities` check before serving large
  files over a metered connection if that matters to you.

## Battery optimization

Android OEM battery managers (Xiaomi/Oppo/Vivo/Samsung, etc.) are the #1
practical reason apps like this get killed in the background even with a
foreground service. `MainActivity` has a button that requests exemption via
`ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` — this must stay a deliberate
user tap (Play Store policy), not something triggered automatically.
