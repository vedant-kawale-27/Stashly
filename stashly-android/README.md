# Stashly Android (Storage Node App)

Stashly Android converts an Android mobile device into a dedicated, hardware-encrypted cloud storage node. By running an autonomous background service that maintains an outbound persistent WebSocket connection to the Stashly broker, the device serves encrypted files on demand without requiring a static public IP, dynamic DNS, or router port forwarding.

---

## Technical Specifications

- **Programming Language**: Kotlin (JVM target 17, Coroutines)
- **Target Android Version**: Android 14 (API level 34)
- **Minimum Android Version**: Android 8.0 Oreo (API level 26)
- **Build System**: Gradle Kotlin DSL (`build.gradle.kts`)
- **Key Dependencies**:
  - `com.squareup.okhttp3:okhttp:4.12.0` (HTTP and WebSocket transport)
  - `androidx.security:security-crypto:1.1.0-alpha06` (Android Keystore EncryptedSharedPreferences)
  - `com.journeyapps:zxing-android-embedded:4.3.0` (Camera QR Code scanning)
  - `org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3` (Asynchronous concurrency)
  - `com.google.android.material:material:1.11.0` (Material 3 UI design system)

---

## Architectural Subsystems

### 1. Cryptographic Engine and Key Management

The application implements an envelope encryption architecture where the device never reveals unencrypted file content or raw encryption keys to the network:

- **Hardware Master Key (`KeyManager.kt`)**: Generates a cryptographically secure 256-bit AES key using `SecureRandom`. The key is persisted locally via `EncryptedSharedPreferences` using `AES256_SIV` for key names and `AES256_GCM` for values, backed by the hardware Android Keystore.
- **Data Encryption Keys (DEKs) (`AesGcm.kt`)**: Every file scanned on the device is encrypted with a unique, randomly generated 256-bit AES-GCM data encryption key.
- **Binary Envelope Format**: Both file ciphertexts and wrapped DEKs use standard AES-256-GCM framing:
  `[12-byte Initialization Vector (IV)][Ciphertext][16-byte GCM Authentication Tag]`
- **DEK Wrapping**: The per-file DEK is encrypted using the device Master Key via `KeyManager.wrapDek()` and output as a Base64 string (`encryptedDek`). Only the `encryptedDek` and file metadata are transmitted to the broker.

### 2. Filesystem Scanner and Vault (`FileVault.kt`)

- **Filesystem Traversal**: When granted `MANAGE_EXTERNAL_STORAGE`, `FileVault` traverses `/storage/emulated/0` using `File.walkTopDown()`, excluding system directories (such as `/Android`).
- **Incremental Sync**: Maintains `vault_metadata.json` in the internal app storage. Compares file modification timestamps (`lastModified`) to avoid re-encrypting unchanged files.
- **Encrypted Local Cache**: Encrypted file ciphertexts are stored in `filesDir/encrypted_cache/<uuid>.bin`. When the broker requests a file, it is read directly from cache for high-throughput responses.
- **Master Key Fingerprinting**: Calculates a SHA-256 fingerprint of the master key. If a node reset or key rotation occurs, cached ciphertexts are invalidated and regenerated.

### 3. Service Lifecycle and Outbound WebSocket (`StorageNodeService.kt`, `BrokerSocketClient.kt`)

- **Outbound Connection Model**: The mobile device dials out to `wss://<broker>/ws/device?token=<deviceToken>`. This bypasses Carrier-Grade NAT (CGNAT), firewall restrictions, and Wi-Fi isolation.
- **Foreground Service Execution**: Runs as a persistent `dataSync` foreground service with ongoing status notifications and quick-action buttons (`Stop Node`).
- **Fault Tolerance and Auto-Reconnect**:
  - Employs exponential backoff reconnects ($2^n$ seconds, capped at 30 seconds).
  - Uses `ConnectivityManager.NetworkCallback` to detect network interface transitions (e.g., Cellular to Wi-Fi) and trigger immediate reconnections.
- **Boot Persistence**: Listens for `android.intent.action.BOOT_COMPLETED` via `BootReceiver` to resume the storage node immediately when the device boots.

### 4. Wire Protocol (`BrokerSocketClient.kt`)

The client exchanges structured JSON messages with the broker over the persistent WebSocket:

| Message Type | Direction | Payload Attributes | Description |
| :--- | :--- | :--- | :--- |
| `hello` | Phone &rarr; Broker | `deviceId` | Initial handshake upon WebSocket connection. |
| `file_sync` | Phone &rarr; Broker | `files: Array<FileSyncEntry>` | Batch sync of file metadata, hashes, MIME types, and wrapped DEKs. |
| `fetch_request` | Broker &rarr; Phone | `requestId`, `path` | Broker requests ciphertext for a specific file path. |
| `fetch_result` | Phone &rarr; Broker | `requestId`, `ok`, `dataBase64`, `error` | Base64-encoded file ciphertext payload returned by the node. |
| `node_unlinked` | Broker &rarr; Phone | `reason` | Notification that the node was removed from the web console; triggers local reset. |
| `client_unlinked` | Broker &rarr; Phone | `userId` | Notification that a specific client was disconnected. |
| `client_presence` | Broker &rarr; Phone | `userId`, `online` | Real-time status update of client activity on the web dashboard. |
| `upload_request` | Broker &rarr; Phone | `requestId`, `path`, `dataBase64`, `encryptedDek` | Sends encrypted ciphertext to the node for storage. |
| `upload_result` | Phone &rarr; Broker | `requestId`, `ok`, `error` | Acknowledges an encrypted upload. |
| `sync_request` | Broker &rarr; Phone | `requestId` | Requests a fresh metadata synchronization. |

---

## Granular Access Control and Scopes

Stashly supports multi-client pairing where each connected user account can be assigned an isolated access scope:

- **`ALL`**: Grants read and stream access to the entire phone storage (`/storage/emulated/0`).
- **`CUSTOM_FOLDER`**: Restricts the client to browse and download only files located inside a specific directory subtree.
- **`CUSTOM_FILE`**: Restricts the client to a single designated file.
- **`NONE`**: Temporarily pauses sharing with that specific client without unpairing the device.

The Android app also reports system information and live storage telemetry to
the broker. Node settings persist locally, and the foreground service exposes
an ongoing notification with a stop action and reconnect status.

### Bluetooth master-key sharing

`BleKeyShareServer.kt` exposes a short-lived, authenticated Bluetooth GATT
session for transferring the device master key to a user-approved browser.
The key remains in the Android app's protected storage and is never sent
through the broker. Bluetooth support depends on the device, browser, and
runtime permissions.

---

## Required Android Permissions

- `android.permission.INTERNET`: Outbound WebSocket and REST API communication.
- `android.permission.ACCESS_NETWORK_STATE`: Network connectivity monitoring.
- `android.permission.FOREGROUND_SERVICE`: Execution of persistent background service.
- `android.permission.FOREGROUND_SERVICE_DATA_SYNC`: Foreground service classification under Android 14 requirements.
- `android.permission.POST_NOTIFICATIONS`: Android 13+ notification permission for foreground service controls.
- `android.permission.RECEIVE_BOOT_COMPLETED`: Auto-start node service upon phone boot.
- `android.permission.MANAGE_EXTERNAL_STORAGE`: Full filesystem access for storage node indexing.
- `android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`: Prompts user to disable OEM battery saver killing the background service.
- `android.permission.CAMERA`: QR code scanner for pairing token exchange.
- `android.permission.BLUETOOTH_ADVERTISE`: Advertise the optional Bluetooth
  key-sharing service on supported Android versions.
- `android.permission.BLUETOOTH_CONNECT`: Accept and manage Bluetooth key
  sharing connections.
- `android.permission.BLUETOOTH_SCAN`: Discover or manage nearby Bluetooth
  devices when required by the platform.

---

## Build and Installation Instructions

1. Open the `stashly-android` directory in Android Studio.
2. Ensure Android SDK 34 and JDK 17 are selected in Project Structure.
3. Sync Gradle and build the project:
   ```bash
   ./gradlew assembleDebug
   ```
4. Deploy the APK to an Android test device or emulator.
5. On initial launch, grant Storage and Notification permissions when prompted.
