// src by SRT X CHEATS. Copy right SRT X CHEATS
import { isResellerTier } from './proTier.js';
import crypto from 'crypto';
import { db } from './firebase.js';

// src by SRT X CHEATS. Copy right SRT X CHEATS
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a || ''), 'hex');
  const y = Buffer.from(String(b || ''), 'hex');
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (!x.length || x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

export function generateCredentials() {
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const apiKey = 'srt_x_' + crypto.randomBytes(24).toString('hex');
  const masterKey = 'srt_x_master_' + crypto.randomBytes(32).toString('hex');
  return {
    apiKey,
    masterKey,
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    apiKeyHash: sha256(apiKey),
    masterKeyHash: sha256(masterKey),
    prefix: `${apiKey.slice(0, 12)}…${apiKey.slice(-4)}`,
  };
}
// src by SRT X CHEATS. Copy right SRT X CHEATS

const credKey = () => {
  const secret = process.env.API_CRED_SECRET;
  return secret && secret.length >= 16 ? crypto.createHash('sha256').update(secret).digest() : null;
};
// src by SRT X CHEATS. Copy right SRT X CHEATS

export const canRevealKeys = () => !!credKey();

export function encryptSecret(plain) {
  const key = credKey();
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (!key) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
// src by SRT X CHEATS. Copy right SRT X CHEATS
}

export function decryptSecret(blob) {
  const key = credKey();
  if (!key || typeof blob !== 'string') return null;
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const [v, iv, tag, data] = blob.split('.');
  if (v !== 'v1' || !iv || !tag || !data) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}
// src by SRT X CHEATS. Copy right SRT X CHEATS

let settingsCache = null;
let settingsCacheAt = 0;
const SETTINGS_TTL_MS = 10_000;

// src by SRT X CHEATS. Copy right SRT X CHEATS
export async function getApiSettings() {
  const now = Date.now();
  if (settingsCache && now - settingsCacheAt < SETTINGS_TTL_MS) return settingsCache;
  const snap = await db().collection('config').doc('api').get();
  const d = snap.exists ? snap.data() : {};
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  settingsCache = { enabled: d.enabled !== false, updatedAt: d.updatedAt || null };
  settingsCacheAt = now;
  return settingsCache;
}

// src by SRT X CHEATS. Copy right SRT X CHEATS
export async function setApiEnabled(enabled) {
  await db().collection('config').doc('api').set({ enabled: !!enabled, updatedAt: Date.now() }, { merge: true });
  settingsCache = null;
  settingsCacheAt = 0;
}
// src by SRT X CHEATS. Copy right SRT X CHEATS

const fail = (status, code, error) => ({ ok: false, status, code, error });

export async function authenticateClient(apiKey, masterKey) {
  if (!apiKey || !masterKey) {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    return fail(401, 'AUTH_REQUIRED', 'Send api_key in the request body and your master key in the x-master-key header.');
  }
  if (apiKey.length > 200 || masterKey.length > 200) {
    return fail(401, 'INVALID_CREDENTIALS', 'Invalid API credentials.');
  }
// src by SRT X CHEATS. Copy right SRT X CHEATS

  const snap = await db().collection('apiClients').where('apiKeyHash', '==', sha256(apiKey)).limit(1).get();
  if (snap.empty) return fail(401, 'INVALID_CREDENTIALS', 'Invalid API credentials.');

  const clientDoc = snap.docs[0];
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const client = clientDoc.data();
  if (!safeEqualHex(sha256(masterKey), client.masterKeyHash)) {
    return fail(401, 'INVALID_CREDENTIALS', 'Invalid API credentials.');
  }
  if (client.disabled) {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    return fail(403, 'API_DISABLED', 'API access for this account has been disabled. Please contact support.');
  }

  const uid = clientDoc.id;
  const userSnap = await db().collection('users').doc(uid).get();
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const user = userSnap.exists ? userSnap.data() : null;
  if (!user || !isResellerTier(user.role || 'user')) {
    return fail(403, 'NOT_RESELLER', 'The reseller API is only available to reseller accounts.');
  }
  if (user.requestStatus === 'Banned') {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    return fail(403, 'ACCOUNT_SUSPENDED', 'This account is suspended. Please contact support.');
  }

  return { ok: true, uid, client, clientRef: clientDoc.ref, user };
}
// src by SRT X CHEATS. Copy right SRT X CHEATS

const lastTouch = new Map();
export function touchLastUsed(clientRef, uid) {
  const now = Date.now();
  if (now - (lastTouch.get(uid) || 0) < 60_000) return;
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  lastTouch.set(uid, now);
  clientRef.update({ lastUsedAt: now }).catch(() => {});
}
