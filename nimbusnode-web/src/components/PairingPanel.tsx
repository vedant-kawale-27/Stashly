import { useState } from "react";
import { BrokerClient } from "../api";

export function PairingPanel({ client }: { client: BrokerClient }) {
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function generate() {
    setError(null);
    setBusy(true);
    try {
      const result = await client.createPairingToken();
      setCode(result.token);
      setExpiresAt(result.expiresAt);
    } catch (err: any) {
      setError(err.message ?? "Failed to generate a pairing code");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>Pair a new phone</h2>
      <p className="muted">
        Generate a code, then enter it in the phone app within 5 minutes.
      </p>
      <button onClick={generate} disabled={busy}>
        {busy ? "Generating…" : "Generate pairing code"}
      </button>
      {error && <p className="error">{error}</p>}
      {code && (
        <p style={{ marginTop: 12 }}>
          <span className="pairing-code">{code}</span>
          <br />
          <span className="muted">Expires at {new Date(expiresAt!).toLocaleTimeString()}</span>
        </p>
      )}
    </div>
  );
}
