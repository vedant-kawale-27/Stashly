import { useState } from "react";
import { BrokerClient } from "../api";

interface Props {
  brokerUrl: string;
  onBrokerUrlChange: (url: string) => void;
  onAuthenticated: (token: string) => void;
}

export function LoginForm({ brokerUrl, onBrokerUrlChange, onAuthenticated }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"login" | "register">("login");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const normalizedBrokerUrl = brokerUrl.trim().replace(/\/+$/, "");
    const normalizedEmail = email.trim();
    if (!normalizedBrokerUrl || !normalizedEmail || !password) {
      setError("Broker URL, email, and password are required");
      return;
    }
    setBusy(true);
    try {
      const client = new BrokerClient(normalizedBrokerUrl);
      const token = mode === "login"
        ? await client.login(normalizedEmail, password)
        : await client.register(normalizedEmail, password);
      onAuthenticated(token);
    } catch (err: any) {
      setError(err.message ?? "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>{mode === "login" ? "Log in" : "Create account"}</h2>
      <form onSubmit={submit}>
        <input
          placeholder="Broker URL (e.g. http://10.24.54.88:4000)"
          value={brokerUrl}
          onChange={(e) => onBrokerUrlChange(e.target.value)}
        />
        <input
          placeholder="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          placeholder="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? "Working…" : mode === "login" ? "Log in" : "Register"}
        </button>{" "}
        <button
          type="button"
          className="secondary"
          onClick={() => setMode(mode === "login" ? "register" : "login")}
        >
          {mode === "login" ? "Need an account?" : "Have an account?"}
        </button>
      </form>
    </div>
  );
}
