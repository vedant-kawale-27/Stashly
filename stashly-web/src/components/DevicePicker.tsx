import { useEffect, useState } from "react";
import { BrokerClient, Device } from "../api";

interface Props {
  client: BrokerClient;
  selectedDeviceId: string | null;
  onSelectDevice: (deviceId: string | null) => void;
  onDevicesChange?: (devices: Device[]) => void;
}

export function DevicePicker({ client, selectedDeviceId, onSelectDevice, onDevicesChange }: Props) {
  const [devices, setDevices] = useState<Device[]>([]);

  useEffect(() => {
    let active = true;
    client.listDevices().then((list) => {
      if (!active) return;
      setDevices(list);
      onDevicesChange?.(list);
      if (!selectedDeviceId && list[0]) onSelectDevice(list[0].id);
    }).catch(() => setDevices([]));
    client.listDevices(true).then((list) => {
      if (!active) return;
      setDevices(list);
      onDevicesChange?.(list);
      if (!selectedDeviceId && list[0]) onSelectDevice(list[0].id);
    }).catch(() => {});
    return () => { active = false; };
  }, [client, selectedDeviceId, onSelectDevice]);

  return (
    <label className="file-device-picker">
      <span>Storage location</span>
      <select value={selectedDeviceId ?? ""} onChange={(event) => onSelectDevice(event.target.value || null)}>
        <option value="">Select a device</option>
        {devices.map((device) => (
          <option key={device.id} value={device.id}>{device.name}</option>
        ))}
      </select>
    </label>
  );
}
