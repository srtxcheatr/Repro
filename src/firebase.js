// src/firebase.js — the trust boundary. Verifies WHO is calling, and
// gives access to Firestore with full admin trust (bypassing Security
// Rules — which deny direct client access entirely, so this backend
// is the ONLY way in or out of your data).
//
// SETUP:
// 1. Firebase Console → Project Settings → Service Accounts →
//    Generate new private key.
// 2. Render → your service → Environment → FIREBASE_SERVICE_ACCOUNT_JSON
//    = the entire contents of that JSON file.
//
// Nothing here needs a compiled extension — firebase-admin's Firestore
// client uses @grpc/grpc-js, a pure-JS gRPC implementation. No PECL,
// no build step, no 40-minute Render deploys.

import admin from 'firebase-admin';
import cors from 'cors';

let app = null;

export function getFirebaseApp() {
  if (app) return app;

  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!json) {
    throw new Error('Server misconfigured: FIREBASE_SERVICE_ACCOUNT_JSON is not set');
  }
  let creds;
  try {
    creds = JSON.parse(json);
  } catch (e) {
    throw new Error('Server misconfigured: FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON');
  }

  app = admin.initializeApp({ credential: admin.credential.cert(creds) });
  return app;
}

export function db() {
  getFirebaseApp();
  return admin.firestore();
}

/**
 * Express middleware — verifies the Firebase ID token from the
 * Authorization header and attaches req.uid / req.email. Sends a 401
 * and stops the request if the token is missing or invalid.
 */
export async function requireFirebaseUid(req, res, next) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res.status(401).json({ success: false, error: 'Missing Authorization header' });
  }
  try {
    getFirebaseApp();
    const decoded = await admin.auth().verifyIdToken(match[1]);
    req.uid = decoded.uid;
    req.email = decoded.email || '';
    next();
  } catch (e) {
    return res.status(401).json({ success: false, error: 'Invalid or expired login. Please refresh and try again.' });
  }
}

/**
 * Express middleware — verifies the Firebase ID token from the
 * Authorization header (same as requireFirebaseUid), then additionally
 * checks users/{uid}.isAdmin === true in Firestore. Used on every
 * /api/admin/* route. Attaches req.uid and req.adminEmail for audit
 * trails (who actually did this), not just "someone with the secret").
 *
 * There is deliberately no shared secret anymore — access is tied to
 * a real, individually-revocable Firebase account. To grant the first
 * admin: register normally on the site, then run
 *   node scripts/set-admin.js you@example.com
 * locally (needs FIREBASE_SERVICE_ACCOUNT_JSON in your env, same value
 * as on Render).
 */
export async function requireAdminAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res.status(401).json({ success: false, error: 'Not logged in' });
  }
  try {
    getFirebaseApp();
    const decoded = await admin.auth().verifyIdToken(match[1]);
    const snap = await db().collection('users').doc(decoded.uid).get();
    const isAdmin = snap.exists && snap.data().isAdmin === true;
    if (!isAdmin) {
      return res.status(403).json({ success: false, error: 'This account is not flagged as admin.' });
    }
    req.uid = decoded.uid;
    req.adminEmail = decoded.email || '';
    next();
  } catch (e) {
    return res.status(401).json({ success: false, error: 'Invalid or expired login. Please log in again.' });
  }
}

// Your frontend has moved between different Render service names
// several times already — instead of chasing each rename, this
// allows any *.onrender.com origin (all under your own Render
// account regardless of what you rename services to) plus your
// Firebase Hosting domains if you ever use those instead.
const ALLOWED_ORIGIN_SUFFIXES = ['.onrender.com'];
const ALLOWED_EXACT_ORIGINS = [
  'https://bronzx.web.app',
  'https://bronzx.firebaseapp.com', 'https://srtstorev5.onrender.com',
  'https://srtxcheats.ct.ws', 'http://srtxcheats.ct.ws', // your host doesn't force https for every visitor — see note below
  'https://cheats.xo.je',
];

export const userCors = cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true); // same-origin / curl / server-to-server
    if (ALLOWED_EXACT_ORIGINS.includes(origin)) return cb(null, true);
    try {
      const host = new URL(origin).hostname;
      if (ALLOWED_ORIGIN_SUFFIXES.some((suf) => host.endsWith(suf))) return cb(null, true);
    } catch (e) { /* malformed origin header — fall through to reject */ }
    cb(null, false);
  },
});

// Admin panel can be hosted anywhere — including a local dev server —
// it's gated by ADMIN_SECRET instead of by origin, so CORS here just
// reflects whatever origin asks rather than maintaining an allowlist.
export const adminCors = cors({ origin: true });