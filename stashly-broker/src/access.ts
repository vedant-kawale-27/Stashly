/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

export interface AccessLink {
  scopeMode: string;
  scopePath: string | null;
  sharingEnabled: boolean;
}

export function isPathAllowed(filePath: string, link: AccessLink): boolean {
  if (!link.sharingEnabled || link.scopeMode === "NONE") return false;
  if (link.scopeMode === "ALL" || !link.scopePath) return true;

  const scope = link.scopePath.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  const normalized = filePath.replace(/\\/g, "/");
  if (link.scopeMode === "CUSTOM_FILE") return normalized === scope;
  return normalized === scope || normalized.startsWith(`${scope}/`);
}

export function isDirectoryEntry(file: { mimeType: string | null; contentHash: string }): boolean {
  return file.mimeType === "inode/directory" || file.mimeType === "directory" || file.contentHash === "directory";
}
