# NimbusNode Broker

The always-on relay server for **NimbusNode**: it lets any client (web, Windows
"map network drive" via WebDAV, etc.) reach files that physically live on a
paired Android phone — even when that phone isn't nearby — by holding a
persistent connection to the phone and relaying requests over it.

The broker **never sees plaintext**. It stores file *metadata* (name, size,
path, content hash) and an opaque **wrapped per-file key** (`encryptedDek`)
that only the user's own devices can unwrap. See "Encryption model" below.

## Stack

- Express (REST API)
- `ws` (WebSocket relay to paired phones)
- Prisma + SQLite for local dev (swap the datasource to Postgres for prod —
  one line in `prisma/schema.prisma`)
- JWT for user sessions and long-lived device tokens

## Setup

```bash
npm install
cp .env.example .env        # then edit JWT_SECRET at minimum
npm run prisma:migrate      # creates dev.db and applies the schema
npm run dev                 # starts on http://localhost:4000
```

## How pieces fit together

1. **User registers/logs in** (`/auth/register`, `/auth/login`) → gets a JWT.
2. **User requests a pairing token** (`POST /devices/pairing-tokens`, auth'd) →
   shows it as a QR code or short code in the web UI.
3. **Phone app scans/enters it** and calls `POST /devices/pair` (no auth
   needed — the pairing token *is* the credential) → gets back a long-lived
   **device token**.
4. **Phone app opens a WebSocket** to `wss://<broker>/ws/device?token=<deviceToken>`
   and keeps it alive (auto-reconnect with backoff). This is what makes the
   phone reachable without a public IP: it always dials out to the broker.
5. **Phone periodically sends `file_sync`** messages over that socket with
   metadata for new/changed files (never file content).
6. **Any client** calls `GET /files` (auth'd) to browse metadata, then
   `GET /files/:id/download` to fetch a file. The broker:
   - relays the request to the phone live if it's online (`deviceHub.requestFile`),
   - otherwise falls back to a cloud cache copy if one exists,
   - otherwise returns `503 DEVICE_OFFLINE_NO_CACHE`.

## Encryption model (see `prisma/schema.prisma` comments)

- Each file is encrypted client-side with its own **data key (DEK)** before
  ever reaching the broker.
- The DEK itself is wrapped with a **master key that lives only on paired
  devices**, never on the broker. The wrapped DEK (`encryptedDek`) is the only
  key material the broker stores, and it's useless without the master key.
- Rotate the **master key** on trust-boundary events (new device paired,
  device lost/unpaired) — this only requires re-wrapping the small DEKs, not
  re-encrypting every file. Don't put the content-encryption key on a fixed
  timer; that just locks you out of your own cached data (see the "should I
  rotate keys every 15 min" discussion — TLS/session-level rotation is fine
  and already handled by TLS 1.3; this is about the separate content key).

## What's stubbed / not yet implemented

- **Cloud cache storage**: `isCached` / `cacheKey` fields and the `501` branch
  in `files.ts` are placeholders. Wire up S3/MinIO there so downloads still
  work when the phone is asleep.
- **Binary framing**: file transfer over the device WebSocket is base64-in-JSON
  for simplicity. For real file sizes, switch to raw binary WS frames with a
  small `requestId + length` header instead.
- **WebDAV translation layer**: not included in this skeleton — it's a thin
  adapter (e.g. `webdav-server` npm package) that maps `PROPFIND`/`GET`/`PUT`
  onto the same `deviceHub`/Prisma logic already here.
- **Rate limiting / refresh tokens / password reset**: none of the auth
  hardening beyond bcrypt + JWT is in place yet.

## API quick reference

| Method | Path                      | Auth    | Purpose                              |
|--------|---------------------------|---------|---------------------------------------|
| POST   | `/auth/register`          | none    | Create user account                   |
| POST   | `/auth/login`              | none    | Get a user JWT                        |
| POST   | `/devices/pairing-tokens` | user    | Generate a short-lived pairing code   |
| POST   | `/devices/pair`           | none*   | Phone exchanges code for device token |
| GET    | `/devices`                | user    | List paired devices + online status   |
| DELETE | `/devices/:id`            | user    | Unpair a device                       |
| GET    | `/files?deviceId=`        | user    | List file metadata                    |
| GET    | `/files/:id/download`     | user    | Fetch a file (relayed or cached)      |

\* protected by the pairing token itself, which is single-use and expires in
`PAIRING_TOKEN_TTL_SECONDS` (default 5 min).
