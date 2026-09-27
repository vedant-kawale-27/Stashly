import { useEffect, useState } from "react";
import { BrokerClient, Device } from "../api";

interface Props {
  client: BrokerClient;
  selectedDeviceId: string | null;
  onSelectDevice: (deviceId: string | null) => void;
}

export function DeviceList({ client, selectedDeviceId, onSelectDevice }: Props) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      setDevices(await client.listDevices());
      setError(null);
    } catch (err: any) {
      setError(err.message ?? "Failed to load devices");
    }
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 10_000); // poll for online/offline changes
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="card">
      <h2>Devices</h2>
      {error && <p className="error">{error}</p>}
      {devices.length === 0 && !error && <p className="muted">No devices paired yet.</p>}
      <table>
        <tbody>
          <tr>
            <td>
              <button
                className={selectedDeviceId === null ? "" : "secondary"}
                onClick={() => onSelectDevice(null)}
              >
                All files
              </button>
            </td>
            <td />
          </tr>
          {devices.map((d) => (
            <tr key={d.id}>
              <td>
                <button
                  className={selectedDeviceId === d.id ? "" : "secondary"}
                  onClick={() => onSelectDevice(d.id)}
                >
                  {d.name}
                </button>
              </td>
              <td>
                <span className={`badge ${d.status}`}>{d.status}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
