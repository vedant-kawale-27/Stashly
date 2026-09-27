import { useEffect, useState } from "react";
import { BrokerClient } from "./api";
import { DeviceList } from "./components/DeviceList";
import { FileBrowser } from "./components/FileBrowser";
import { LoginForm } from "./components/LoginForm";
import { MasterKeyPanel } from "./components/MasterKeyPanel";
import { PairingPanel } from "./components/PairingPanel";

const STORAGE_KEYS = {
  brokerUrl: "nimbusnode_broker_url",
  token: "nimbusnode_token",
  masterKey: "nimbusnode_master_key",
};

export default function App() {
  const [brokerUrl, setBrokerUrl] = useState(() => localStorage.getItem(STORAGE_KEYS.brokerUrl) ?? "");
  const [token, setToken] = useState(() => localStorage.getItem(STORAGE_KEYS.token) ?? "");
  const [masterKey, setMasterKey] = useState(() => localStorage.getItem(STORAGE_KEYS.masterKey) ?? "");
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);

  useEffect(() => localStorage.setItem(STORAGE_KEYS.brokerUrl, brokerUrl), [brokerUrl]);
  useEffect(() => localStorage.setItem(STORAGE_KEYS.token, token), [token]);
  useEffect(() => localStorage.setItem(STORAGE_KEYS.masterKey, masterKey), [masterKey]);

  const client = new BrokerClient(brokerUrl, token || undefined);

  return (
    <div className="app-shell">
      <h1>NimbusNode</h1>

      {!token ? (
        <LoginForm brokerUrl={brokerUrl} onBrokerUrlChange={setBrokerUrl} onAuthenticated={setToken} />
      ) : (
        <>
          <div className="card">
            <span className="muted">Connected to {brokerUrl}</span>{" "}
            <button className="secondary" onClick={() => setToken("")}>
              Log out
            </button>
          </div>
          <MasterKeyPanel masterKey={masterKey} onChange={setMasterKey} />
          <PairingPanel client={client} />
          <DeviceList client={client} selectedDeviceId={selectedDeviceId} onSelectDevice={setSelectedDeviceId} />
          <FileBrowser client={client} deviceId={selectedDeviceId} masterKey={masterKey} />
        </>
      )}
    </div>
  );
}
