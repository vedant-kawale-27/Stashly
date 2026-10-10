/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

export interface DeviceSharingChangedEvent {
  type: "device_sharing_changed";
  deviceId: string;
  sharingPaused?: boolean;
  sharingEnabled?: boolean;
}

export interface DeviceTelemetryChangedEvent {
  type: "device_telemetry_changed";
  deviceId: string;
  status?: "online" | "offline";
  modelName?: string | null;
  modelNumber?: string | null;
  androidVersion?: string | null;
  osVersion?: string | null;
  appVersion?: string | null;
  batteryLevel?: number | null;
  storageTotalMb?: number | null;
  storageFreeMb?: number | null;
  sdcardMounted?: boolean | null;
  sdcardTotalMb?: number | null;
  sdcardFreeMb?: number | null;
}

export type RealtimeEvent = DeviceSharingChangedEvent | DeviceTelemetryChangedEvent;
type Listener = (event: RealtimeEvent) => void;

let socket: WebSocket | null = null;
let reconnectTimer: number | null = null;
let reconnectAttempt = 0;
let activeConnection = 0;
const listeners = new Set<Listener>();

function notify(event: RealtimeEvent) {
  for (const listener of listeners) listener(event);
}

function scheduleReconnect(connectionId: number, connect: () => void) {
  if (connectionId !== activeConnection || reconnectTimer !== null) return;
  const delay = Math.min(30_000, 1_000 * 2 ** reconnectAttempt++);
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

export function startRealtime(brokerUrl: string, token: string): () => void {
  const connectionId = ++activeConnection;
  const wsBase = brokerUrl.replace(/^http/, "ws").replace(/\/+$/, "");
  let stopped = false;

  const connect = () => {
    if (stopped || connectionId !== activeConnection) return;
    const url = `${wsBase}/ws/client?token=${encodeURIComponent(token)}`;
    const nextSocket = new WebSocket(url);
    socket = nextSocket;

    nextSocket.onopen = () => {
      reconnectAttempt = 0;
    };
    nextSocket.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as RealtimeEvent;
        if (
          (event?.type === "device_sharing_changed" || event?.type === "device_telemetry_changed") &&
          typeof event.deviceId === "string"
        ) {
          notify(event);
        }
      } catch {
        // Ignore malformed broker events and keep the connection alive.
      }
    };
    nextSocket.onclose = () => {
      if (socket === nextSocket) socket = null;
      scheduleReconnect(connectionId, connect);
    };
    nextSocket.onerror = () => {
      nextSocket.close();
    };
  };

  connect();
  return () => {
    stopped = true;
    if (connectionId === activeConnection) activeConnection++;
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (socket) {
      socket.close();
      socket = null;
    }
  };
}

export function subscribeRealtime(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
