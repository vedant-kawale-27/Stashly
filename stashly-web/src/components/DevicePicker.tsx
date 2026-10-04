/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

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
      <select value={selectedDeviceId ?? ""} onChange={(event) => onSelectDevice(event.target.value || null)}>
        <option value="">Select a device</option>
        {devices.map((device) => (
          <option key={device.id} value={device.id}>{device.name}</option>
        ))}
      </select>
    </label>
  );
}
