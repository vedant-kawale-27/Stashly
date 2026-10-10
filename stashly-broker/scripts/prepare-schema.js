#!/usr/bin/env node
/*
 * Copyright (C) 2026 Vedant Kawale
 * Stashly Broker - Dynamic Prisma Schema & Database Provider Selector
 * Automatically configures SQLite for development and PostgreSQL for production
 * based on NODE_ENV.
 */

const fs = require('fs');
const path = require('path');

// Basic .env parser if dotenv isn't loaded yet
function loadEnv() {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
}

loadEnv();

const nodeEnv = (process.env.NODE_ENV || 'development').trim().toLowerCase();
const isProd = nodeEnv === 'production';
const targetProvider = isProd ? 'postgresql' : 'sqlite';

const schemaPath = path.resolve(__dirname, '..', 'prisma', 'schema.prisma');
if (!fs.existsSync(schemaPath)) {
  console.error(`[prepare-schema] schema.prisma not found at ${schemaPath}`);
  process.exit(1);
}

let schema = fs.readFileSync(schemaPath, 'utf8');

// Match provider inside datasource db { ... }
const providerRegex = /(datasource\s+db\s*\{[\s\S]*?provider\s*=\s*)"(?:sqlite|postgresql|postgres)"([\s\S]*?\})/;

if (!providerRegex.test(schema)) {
  console.error('[prepare-schema] Could not find datasource db provider in schema.prisma');
  process.exit(1);
}

const currentProviderMatch = schema.match(/datasource\s+db\s*\{[\s\S]*?provider\s*=\s*"([^"]+)"/);
const currentProvider = currentProviderMatch ? currentProviderMatch[1] : null;

if (currentProvider !== targetProvider) {
  schema = schema.replace(providerRegex, `$1"${targetProvider}"$2`);
  fs.writeFileSync(schemaPath, schema, 'utf8');
  console.log(`[prepare-schema] NODE_ENV="${nodeEnv}": Updated Prisma provider from "${currentProvider}" to "${targetProvider}".`);
} else {
  console.log(`[prepare-schema] NODE_ENV="${nodeEnv}": Prisma provider is already "${targetProvider}".`);
}

// Check DATABASE_URL compatibility
const dbUrl = process.env.DATABASE_URL;
if (isProd) {
  if (dbUrl && (dbUrl.startsWith('file:') || !dbUrl.includes('://'))) {
    console.warn(`[prepare-schema] WARNING: In production (NODE_ENV=production), DATABASE_URL should be a PostgreSQL URL (e.g. postgresql://user:pass@host:5432/db). Current value: "${dbUrl}"`);
  }
} else {
  if (!dbUrl) {
    process.env.DATABASE_URL = 'file:./dev.db';
  }
}
