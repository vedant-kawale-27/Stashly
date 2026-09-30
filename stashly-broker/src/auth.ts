/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { v4 as uuid } from "uuid";
import { config } from "./config";

export interface UserTokenPayload {
  userId: string;
  email: string;
}

export interface DeviceTokenPayload {
  deviceId: string;
  userId: string;
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function signUserToken(payload: UserTokenPayload): string {
  const options: jwt.SignOptions = { expiresIn: config.jwtExpiresIn as jwt.SignOptions["expiresIn"] };
  return jwt.sign(payload, config.jwtSecret, options);
}

export function verifyUserToken(token: string): UserTokenPayload {
  return jwt.verify(token, config.jwtSecret) as UserTokenPayload;
}

// Device tokens are issued once a phone completes pairing and are used
// to authenticate the phone's persistent WebSocket connection.
export function signDeviceToken(payload: DeviceTokenPayload): string {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: "365d" });
}

export function verifyDeviceToken(token: string): DeviceTokenPayload {
  return jwt.verify(token, config.jwtSecret) as DeviceTokenPayload;
}

export function generatePairingToken(): string {
  // Short opaque token shown as a QR code / typed code on the phone app.
  return uuid().replace(/-/g, "").slice(0, 8).toUpperCase();
}
