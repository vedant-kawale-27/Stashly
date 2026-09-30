/*
 * Copyright (C) 2026 Vedant Kawale
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 */

/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BROKER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
