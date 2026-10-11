// src/loadEnv.js — tiny, dependency-free .env loader.
// Reads KEY=VALUE lines from a local ".env" file (if present) into
// process.env WITHOUT overriding variables that are already set (so
// Render's Environment tab always wins). On Render you normally don't
// need a .env file at all — this is for local testing.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(dir, '..', '.env');

try {
  if (fs.existsSync(file)) {
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  }
} catch (e) {
  console.warn('[env] could not read .env:', e.message);
}
