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
