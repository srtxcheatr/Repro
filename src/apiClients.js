// src/apiClients.js — reseller API credentials.
//
// Every reseller gets their OWN api_key + master key (never shared between
// users). Storage rules:
//   * Requests are checked against SHA-256 hashes. The recoverable copy (for
//     the reseller's own "show / copy key" buttons) is AES-256-GCM encrypted
//     with a server-side secret — see "Reveal-able keys" below. A database
//     leak alone therefore can't leak usable keys.
//   * Stored in `apiClients/{uid}` — a server-only collection (no Firestore
//     security rule opens it to browsers), NOT on the users/{uid} document,
//     because users can write to their own user document from the client
//     under the current rules, and an admin "disabled" flag must not be
//     something a user could flip back themselves.
//   * Requests authenticate with BOTH keys: api_key (body) + x-master-key
//     (header). Wrong either way gives the same generic 401, so an attacker
//     can't tell which half was right.

import crypto from 'crypto';
import { db } from './firebase.js';

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a || ''), 'hex');
  const y = Buffer.from(String(b || ''), 'hex');
  if (!x.length || x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/** 192-bit api key + 256-bit master key, plus the hashes that get stored. */
export function generateCredentials() {
  const apiKey = 'srt_x_' + crypto.randomBytes(24).toString('hex');
  const masterKey = 'srt_x_master_' + crypto.randomBytes(32).toString('hex');
  return {
    apiKey,
    masterKey,
    apiKeyHash: sha256(apiKey),
    masterKeyHash: sha256(masterKey),
    // Safe-to-display hint so a reseller can recognise WHICH key is active.
    prefix: `${apiKey.slice(0, 12)}…${apiKey.slice(-4)}`,
  };
}

// ---------------------------------------------------------------
// Reveal-able keys. The reseller page lets a reseller tap "show" / "copy" on
// their key at any time (like the upstream panel does), so the keys must be
// recoverable — but NOT readable by anyone who only has a copy of the
// database. They are therefore stored AES-256-GCM encrypted, with a secret
// (API_CRED_SECRET, set on Render) that never touches Firestore. The SHA-256
// hashes above are still what requests are checked against.
//
// If API_CRED_SECRET is not set, nothing recoverable is stored and the page
// falls back to "shown once at generation" — it never silently stores keys
// in readable form.
// ---------------------------------------------------------------
const credKey = () => {
  const secret = process.env.API_CRED_SECRET;
  return secret && secret.length >= 16 ? crypto.createHash('sha256').update(secret).digest() : null;
};

export const canRevealKeys = () => !!credKey();

export function encryptSecret(plain) {
  const key = credKey();
  if (!key) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}

/** Returns the plaintext, or null if it can't be decrypted (wrong secret / tampered / missing). */
export function decryptSecret(blob) {
  const key = credKey();
  if (!key || typeof blob !== 'string') return null;
  const [v, iv, tag, data] = blob.split('.');
  if (v !== 'v1' || !iv || !tag || !data) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------
// Global on/off switch (config/api) — an emergency brake for the whole
// reseller API (e.g. the upstream is down, or someone is abusing it).
// Cached for a few seconds so it costs almost nothing per request.
// ---------------------------------------------------------------
let settingsCache = null;
let settingsCacheAt = 0;
const SETTINGS_TTL_MS = 10_000;

export async function getApiSettings() {
  const now = Date.now();
  if (settingsCache && now - settingsCacheAt < SETTINGS_TTL_MS) return settingsCache;
  const snap = await db().collection('config').doc('api').get();
  const d = snap.exists ? snap.data() : {};
  settingsCache = { enabled: d.enabled !== false, updatedAt: d.updatedAt || null }; // ON unless explicitly turned off
  settingsCacheAt = now;
  return settingsCache;
}

export async function setApiEnabled(enabled) {
  await db().collection('config').doc('api').set({ enabled: !!enabled, updatedAt: Date.now() }, { merge: true });
  settingsCache = null;
  settingsCacheAt = 0;
}

// ---------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------
const fail = (status, code, error) => ({ ok: false, status, code, error });

/**
 * Verifies api_key + master key, then checks the account behind them is still
 * allowed to use the API *right now* (still a reseller, not banned, not
 * switched off by an admin). Checked on every request, so demoting a user or
 * disabling their API takes effect immediately.
 */
export async function authenticateClient(apiKey, masterKey) {
  if (!apiKey || !masterKey) {
    return fail(401, 'AUTH_REQUIRED', 'Send api_key in the request body and your master key in the x-master-key header.');
  }
  if (apiKey.length > 200 || masterKey.length > 200) {
    return fail(401, 'INVALID_CREDENTIALS', 'Invalid API credentials.');
  }

  const snap = await db().collection('apiClients').where('apiKeyHash', '==', sha256(apiKey)).limit(1).get();
  if (snap.empty) return fail(401, 'INVALID_CREDENTIALS', 'Invalid API credentials.');

  const clientDoc = snap.docs[0];
  const client = clientDoc.data();
  if (!safeEqualHex(sha256(masterKey), client.masterKeyHash)) {
    return fail(401, 'INVALID_CREDENTIALS', 'Invalid API credentials.');
  }
  if (client.disabled) {
    return fail(403, 'API_DISABLED', 'API access for this account has been disabled. Please contact support.');
  }

  const uid = clientDoc.id;
  const userSnap = await db().collection('users').doc(uid).get();
  const user = userSnap.exists ? userSnap.data() : null;
  if (!user || (user.role || 'user') !== 'reseller') {
    return fail(403, 'NOT_RESELLER', 'The reseller API is only available to reseller accounts.');
  }
  if (user.requestStatus === 'Banned') {
    return fail(403, 'ACCOUNT_SUSPENDED', 'This account is suspended. Please contact support.');
  }

  return { ok: true, uid, client, clientRef: clientDoc.ref, user };
}

// "Last used" is shown in the admin panel. Writing it on every request would
// be wasteful, so it's throttled to once a minute per reseller and never
// blocks or fails a request.
const lastTouch = new Map();
export function touchLastUsed(clientRef, uid) {
  const now = Date.now();
  if (now - (lastTouch.get(uid) || 0) < 60_000) return;
  lastTouch.set(uid, now);
  clientRef.update({ lastUsedAt: now }).catch(() => {});
}
