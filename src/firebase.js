// src by SRT X CHEATS. Copy right SRT X CHEATS
import admin from 'firebase-admin';
import cors from 'cors';
import crypto from 'crypto';

// src by SRT X CHEATS. Copy right SRT X CHEATS
let app = null;

export function getFirebaseApp() {
  if (app) return app;

  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!json) {
    throw new Error('Server misconfigured: FIREBASE_SERVICE_ACCOUNT_JSON is not set');
  }
  let creds;
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  try {
    creds = JSON.parse(json);
  } catch (e) {
    throw new Error('Server misconfigured: FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON');
  }
// src by SRT X CHEATS. Copy right SRT X CHEATS

  app = admin.initializeApp({ credential: admin.credential.cert(creds) });
  return app;
}

// src by SRT X CHEATS. Copy right SRT X CHEATS
export function db() {
  getFirebaseApp();
  return admin.firestore();
}

// src by SRT X CHEATS. Copy right SRT X CHEATS
export async function requireFirebaseUid(req, res, next) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res.status(401).json({ success: false, error: 'Missing Authorization header' });
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  }
  try {
    getFirebaseApp();
    const decoded = await admin.auth().verifyIdToken(match[1]);
    req.uid = decoded.uid;
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    req.email = decoded.email || '';
  } catch (e) {
    return res.status(401).json({ success: false, error: 'Invalid or expired login. Please refresh and try again.' });
  }

  // src by SRT X CHEATS. Copy right SRT X CHEATS
  try {
    const [{ getUserDoc }, { activeBan, banBody }] = await Promise.all([import('./userCache.js'), import('./ban.js')]);
    const u = await getUserDoc(req.uid);
    const ban = u && u.exists ? activeBan(u.data) : null;
    if (ban) {
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      return res.status(403).json(banBody(ban, {
        name: u.data.profileName || '', uid: req.uid, email: u.data.email || req.email,
      }));
    }
  } catch (e) {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    console.error('[ban] check failed, allowing request', e && e.message);
  }
  next();
}

// src by SRT X CHEATS. Copy right SRT X CHEATS
export function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_SECRET;
  const given = String(req.headers['x-admin-secret'] || '');

  if (!expected || !timingSafeStringEqual(given, expected)) {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    return res.status(401).json({ success: false, error: 'Not authorized' });
  }
  next();
}

// src by SRT X CHEATS. Copy right SRT X CHEATS
export function requireEmployee(req, res, next) {
  const expected = process.env.EMPLOYEE_SECRET;
  const given = String(req.headers['x-employee-secret'] || '');

  if (!expected || !timingSafeStringEqual(given, expected)) {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    return res.status(401).json({ success: false, error: 'Not authorized' });
  }
  next();
}

// src by SRT X CHEATS. Copy right SRT X CHEATS
function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// src by SRT X CHEATS. Copy right SRT X CHEATS
const csv = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);

const ALLOWED_ORIGIN_SUFFIXES = ['.onrender.com', ...csv(process.env.ALLOWED_ORIGIN_SUFFIXES)];
const ALLOWED_EXACT_ORIGINS = [...new Set([
  'https://bronzx.web.app',
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  'https://bronzx.firebaseapp.com',
  'https://srtxcheats.com',
  'https://srtxcheats.ct.ws',
  'http://srtxcheats.ct.ws',
  'https://www.srtxcheats.com',
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  ...csv(process.env.ALLOWED_ORIGINS),
])];

export const userCors = cors({
  origin(origin, cb) {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    if (!origin) return cb(null, true);
    if (ALLOWED_EXACT_ORIGINS.includes(origin)) return cb(null, true);
    try {
      const host = new URL(origin).hostname;
      if (ALLOWED_ORIGIN_SUFFIXES.some((suf) => host.endsWith(suf))) return cb(null, true);
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    } catch (e) {  }
    cb(null, false);
  },
});

// src by SRT X CHEATS. Copy right SRT X CHEATS
export const adminCors = cors({ origin: true });
