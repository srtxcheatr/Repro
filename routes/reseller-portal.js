// routes/reseller-portal.js — what apicontact.php talks to.
//
// This is the logged-in side of the reseller API: a reseller views the
// product list / their recent API orders and generates their own credentials.
// (The API itself — the thing their server calls — is routes/reseller-api.js.)
//
// Every route here requires a verified Firebase login AND role === 'reseller',
// re-read from Firestore on each call, so a demoted user loses access at once.

import express from 'express';
import { asyncHandler } from '../src/asyncHandler.js';
import { db, requireFirebaseUid, userCors } from '../src/firebase.js';
import { rateLimit } from '../src/security.js';
import { generateCredentials, getApiSettings, encryptSecret, decryptSecret, canRevealKeys } from '../src/apiClients.js';
import { listApiProducts } from '../src/resellerApiCatalog.js';
import { telegramNotify, esc } from '../src/telegram.js';

const router = express.Router();
router.use(userCors);
router.use(requireFirebaseUid);

export const API_PATH = '/api/reseller/v1';

const requireReseller = asyncHandler(async (req, res, next) => {
  const snap = await db().collection('users').doc(req.uid).get();
  const data = snap.exists ? snap.data() : {};
  if ((data.role || 'user') !== 'reseller') {
    return res.status(403).json({
      success: false, code: 'NOT_RESELLER',
      error: 'The reseller API is only available to reseller accounts.',
    });
  }
  req.userData = data;
  next();
});

// GET /api/reseller-portal/overview — everything apicontact.php shows.
router.get('/overview', requireReseller, asyncHandler(async (req, res) => {
  const clientRef = db().collection('apiClients').doc(req.uid);
  const [settings, clientSnap, products, ordersSnap] = await Promise.all([
    getApiSettings(),
    clientRef.get(),
    listApiProducts(),
    db().collection('users').doc(req.uid).collection('apiOrders').orderBy('createdAt', 'desc').limit(15).get(),
  ]);

  const c = clientSnap.exists ? clientSnap.data() : null;
  res.json({
    success: true,
    api: { enabled: settings.enabled, path: API_PATH, maxQuantity: 100 },
    balance: Number(req.userData.balance || 0),
    // The overview only ever carries a recognisable hint. The real keys come from
    // GET /credentials/reveal, and only when the reseller taps show/copy.
    credentials: c
      ? { exists: true, prefix: c.prefix, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt || null, disabled: !!c.disabled,
          revealable: !!(c.apiKeyEnc && c.masterKeyEnc && canRevealKeys()) }
      : { exists: false },
    products: products.map((p) => ({
      name: p.row, pid: p.pid, duration: p.label, price: p.price,
      status: p.status, requiresAndroidId: p.requiresAndroidId,
    })),
    orders: ordersSnap.docs.map((d) => {
      const o = d.data();
      return {
        orderId: o.orderId, status: o.status, product: o.productRow, pid: o.pid, duration: o.durationLabel,
        quantity: o.quantity, delivered: o.delivered || 0, charged: o.charged || 0, refunded: o.refunded || 0,
        keys: o.keys || [], createdAt: o.createdAt,
      };
    }),
  });
}));

// POST /api/reseller-portal/credentials — generate OR regenerate.
// The plaintext keys are in THIS response only; they are never stored.
// Regenerating replaces the old pair instantly (the old keys stop working).
router.post('/credentials', rateLimit({ windowMs: 60_000, max: 6, name: 'api-credentials' }), requireReseller, asyncHandler(async (req, res) => {
  const settings = await getApiSettings();
  if (!settings.enabled) {
    return res.status(503).json({ success: false, code: 'API_OFFLINE', error: 'The reseller API is temporarily offline.' });
  }

  const creds = generateCredentials();
  const clientRef = db().collection('apiClients').doc(req.uid);
  let regenerated = false;
  let blocked = false;

  await db().runTransaction(async (tx) => {
    blocked = false;
    const snap = await tx.get(clientRef);
    const old = snap.exists ? snap.data() : null;
    if (old?.disabled) { blocked = true; return; } // an admin switched this account off — can't self-reset
    regenerated = !!old;
    tx.set(clientRef, {
      uid: req.uid,
      email: req.userData.email || req.email || '',
      apiKeyHash: creds.apiKeyHash,
      masterKeyHash: creds.masterKeyHash,
      prefix: creds.prefix,
      // null when API_CRED_SECRET isn't configured -> the page shows keys once only.
      apiKeyEnc: encryptSecret(creds.apiKey),
      masterKeyEnc: encryptSecret(creds.masterKey),
      createdAt: old?.createdAt || Date.now(),
      regeneratedAt: old ? Date.now() : null,
      lastUsedAt: null,
      disabled: false,
    });
  });

  if (blocked) {
    return res.status(403).json({ success: false, code: 'API_DISABLED', error: 'API access for this account has been disabled. Please contact support.' });
  }

  telegramNotify(
    `🔑 <b>API CREDENTIALS ${regenerated ? 'REGENERATED' : 'CREATED'}</b>\n` +
    `✉️ ${esc(req.userData.email || req.email || '—')}\n🆔 <code>${esc(req.uid)}</code>`, 'reseller');

  res.json({
    success: true, regenerated,
    apiKey: creds.apiKey, masterKey: creds.masterKey, prefix: creds.prefix,
    revealable: canRevealKeys(),
  });
}));

// GET /api/reseller-portal/credentials/reveal — the reseller taps "show" or
// "copy" on their key. Decrypts their own stored keys, for them only.
router.get('/credentials/reveal', rateLimit({ windowMs: 60_000, max: 20, name: 'api-reveal' }), requireReseller, asyncHandler(async (req, res) => {
  const snap = await db().collection('apiClients').doc(req.uid).get();
  if (!snap.exists) {
    return res.status(404).json({ success: false, code: 'NO_CREDENTIALS', error: 'Generate your API keys first.' });
  }
  const c = snap.data();
  if (c.disabled) {
    return res.status(403).json({ success: false, code: 'API_DISABLED', error: 'API access for this account has been disabled. Please contact support.' });
  }
  const apiKey = decryptSecret(c.apiKeyEnc);
  const masterKey = decryptSecret(c.masterKeyEnc);
  if (!apiKey || !masterKey) {
    return res.status(409).json({
      success: false, code: 'NOT_REVEALABLE',
      error: 'Your keys can no longer be displayed. Tap Re-generate to get a new pair.',
    });
  }
  res.json({ success: true, apiKey, masterKey });
}));

export default router;
