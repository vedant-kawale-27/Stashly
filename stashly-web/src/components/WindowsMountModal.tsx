/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

import { Device } from "../api";

interface Props {
  device: Device;
  onClose: () => void;
}

export function WindowsMountModal({ device, onClose }: Props) {
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog-content" onClick={(event) => event.stopPropagation()}>
        <button className="dialog-close-btn" onClick={onClose} aria-label="Close">
          X
        </button>

        <div className="dialog-section">
          <h3>Native Windows drive mapping</h3>
          <p>
            {device.name} cannot yet be mapped as a native Windows drive. Stashly does not currently ship a native Windows drive agent.
          </p>
        </div>

        <div className="dialog-note">
          Use the browser-based file browser from the Files tab to view, preview, download, and upload encrypted files from Windows.
        </div>

        <div className="dialog-footer">
          <button className="btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
