# Stashly Desktop Sync

The desktop package is a small TypeScript/Node.js command-line client for
materializing encrypted Stashly files into a local directory. It uses the
broker's authenticated file metadata and download APIs and never receives the
Android master key.

## Requirements

- Node.js 18 or newer
- A running Stashly broker
- A valid web-session JWT and paired device ID

## Build and run

```bash
npm install
npm run build

set STASHLY_BROKER_URL=http://localhost:4000
set STASHLY_TOKEN=<jwt>
set STASHLY_DEVICE_ID=<device-id>
set STASHLY_SYNC_DIR=.\stashly-sync
npm run sync
```

On PowerShell, use `$env:STASHLY_TOKEN = "<jwt>"` and the equivalent syntax
for the other variables. The defaults are `http://localhost:4000` and
`./stashly-sync`.

The sync command:

1. Lists files visible to the authenticated user and selected device.
2. Skips directories and files whose content hash is already in the local
   `.stashly-manifest.json`.
3. Downloads ciphertext and writes it beneath the configured sync directory.
4. Updates the manifest after a successful pass.

Paths are normalized below the destination directory. The output remains
encrypted; use the web console or a future decryption workflow with the
device master key to access plaintext.
