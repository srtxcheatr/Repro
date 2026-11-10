// src by SRT X CHEATS. Copy right SRT X CHEATS
import { isResellerTier } from '../src/proTier.js';
import express from 'express';
import { asyncHandler } from '../src/asyncHandler.js';
import { db, requireFirebaseUid, userCors } from '../src/firebase.js';
// src by SRT X CHEATS. Copy right SRT X CHEATS
import { rateLimit } from '../src/security.js';
import { generatePiCredentials, generateCredentials, getApiSettings, encryptSecret, decryptSecret, canRevealKeys } from '../src/apiClients.js';
import { listApiProducts, listPiProducts, PI_MARKUP_PERCENT } from '../src/resellerApiCatalog.js';
import { telegramNotify, esc } from '../src/telegram.js';

// src by SRT X CHEATS. Copy right SRT X CHEATS
const router = express.Router();
router.use(userCors);
router.use(requireFirebaseUid);

export const API_PATH = '/api/reseller/v1';
// src by SRT X CHEATS. Copy right SRT X CHEATS

const requireReseller = asyncHandler(async (req, res, next) => {
  const snap = await db().collection('users').doc(req.uid).get();
  const data = snap.exists ? snap.data() : {};
  if (!isResellerTier(data.role || 'user')) {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    return res.status(403).json({
      success: false, code: 'NOT_RESELLER',
      error: 'The reseller API is only available to reseller accounts.',
    });
  }
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  req.userData = data;
  next();
});

router.get('/overview', requireReseller, asyncHandler(async (req, res) => {
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const clientRef = db().collection('apiClients').doc(req.uid);
  const [settings, clientSnap, products, ordersSnap] = await Promise.all([
    getApiSettings(),
    clientRef.get(),
    listApiProducts(req.userData.role || 'reseller'),
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    db().collection('users').doc(req.uid).collection('apiOrders').orderBy('createdAt', 'desc').limit(15).get(),
  ]);

  const c = clientSnap.exists ? clientSnap.data() : null;
  res.json({
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    success: true,
    api: { enabled: settings.enabled, path: API_PATH, maxQuantity: 100 },
    balance: Number(req.userData.balance || 0),
    credentials: c
      ? { exists: true, prefix: c.prefix, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt || null, disabled: !!c.disabled,
          // src by SRT X CHEATS. Copy right SRT X CHEATS
          revealable: !!(c.apiKeyEnc && c.masterKeyEnc && canRevealKeys()) }
      : { exists: false },
    products: products.map((p) => ({
      name: p.row, pid: p.pid, duration: p.label, price: p.price,
      status: p.status, requiresAndroidId: p.requiresAndroidId, stock: p.stock,
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    })),
    orders: ordersSnap.docs.map((d) => {
      const o = d.data();
      return {
        orderId: o.orderId, status: o.status, product: o.productRow, pid: o.pid, duration: o.durationLabel,
        // src by SRT X CHEATS. Copy right SRT X CHEATS
        quantity: o.quantity, delivered: o.delivered || 0, charged: o.charged || 0, refunded: o.refunded || 0,
        keys: o.keys || [], createdAt: o.createdAt,
      };
    }),
  });
// src by SRT X CHEATS. Copy right SRT X CHEATS
}));

router.post('/credentials', rateLimit({ windowMs: 60_000, max: 6, name: 'api-credentials' }), requireReseller, asyncHandler(async (req, res) => {
  const settings = await getApiSettings();
  if (!settings.enabled) {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    return res.status(503).json({ success: false, code: 'API_OFFLINE', error: 'The reseller API is temporarily offline.' });
  }

  const creds = generateCredentials();
  const clientRef = db().collection('apiClients').doc(req.uid);
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  let regenerated = false;
  let blocked = false;

  await db().runTransaction(async (tx) => {
    blocked = false;
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    const snap = await tx.get(clientRef);
    const old = snap.exists ? snap.data() : null;
    if (old?.disabled) { blocked = true; return; }
    regenerated = !!old;
    tx.set(clientRef, {
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      uid: req.uid,
      email: req.userData.email || req.email || '',
      apiKeyHash: creds.apiKeyHash,
      masterKeyHash: creds.masterKeyHash,
      prefix: creds.prefix,
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      apiKeyEnc: encryptSecret(creds.apiKey),
      masterKeyEnc: encryptSecret(creds.masterKey),
      createdAt: old?.createdAt || Date.now(),
      regeneratedAt: old ? Date.now() : null,
      lastUsedAt: null,
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      disabled: false,
    });
  });

  if (blocked) {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    return res.status(403).json({ success: false, code: 'API_DISABLED', error: 'API access for this account has been disabled. Please contact support.' });
  }

  telegramNotify(
    `🔑 <b>API CREDENTIALS ${regenerated ? 'REGENERATED' : 'CREATED'}</b>\n` +
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    `✉️ ${esc(req.userData.email || req.email || '—')}\n🆔 <code>${esc(req.uid)}</code>`, 'reseller');

  res.json({
    success: true, regenerated,
    apiKey: creds.apiKey, masterKey: creds.masterKey, prefix: creds.prefix,
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    revealable: canRevealKeys(),
  });
}));

router.get('/credentials/reveal', rateLimit({ windowMs: 60_000, max: 20, name: 'api-reveal' }), requireReseller, asyncHandler(async (req, res) => {
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const snap = await db().collection('apiClients').doc(req.uid).get();
  if (!snap.exists) {
    return res.status(404).json({ success: false, code: 'NO_CREDENTIALS', error: 'Generate your API keys first.' });
  }
  const c = snap.data();
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (c.disabled) {
    return res.status(403).json({ success: false, code: 'API_DISABLED', error: 'API access for this account has been disabled. Please contact support.' });
  }
  const apiKey = decryptSecret(c.apiKeyEnc);
  const masterKey = decryptSecret(c.masterKeyEnc);
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (!apiKey || !masterKey) {
    return res.status(409).json({
      success: false, code: 'NOT_REVEALABLE',
      error: 'Your keys can no longer be displayed. Tap Re-generate to get a new pair.',
    });
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  }
  res.json({ success: true, apiKey, masterKey });
}));

// ───────────── PI KEY (all roles: user / reseller / pro_reseller) ─────────────
export const PI_API_PATH = '/api/pi/v1';

const loadUser = asyncHandler(async (req, res, next) => {
  const snap = await db().collection('users').doc(req.uid).get();
  req.userData = snap.exists ? snap.data() : {};
  next();
});

router.get('/pi/overview', loadUser, asyncHandler(async (req, res) => {
  const [settings, snap, products] = await Promise.all([
    getApiSettings(),
    db().collection('piClients').doc(req.uid).get(),
    listPiProducts(req.userData.role || 'user'),
  ]);
  const c = snap.exists ? snap.data() : null;
  res.json({
    success: true,
    api: { enabled: settings.enabled, path: PI_API_PATH, markupPercent: PI_MARKUP_PERCENT },
    role: req.userData.role || 'user',
    credentials: c
      ? { exists: true, prefix: c.prefix, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt || null, disabled: !!c.disabled,
          revealable: !!(c.piKeyEnc && canRevealKeys()) }
      : { exists: false },
    products,
  });
}));

router.post('/pi/credentials', rateLimit({ windowMs: 60_000, max: 6, name: 'pi-credentials' }), loadUser, asyncHandler(async (req, res) => {
  const settings = await getApiSettings();
  if (!settings.enabled) return res.status(503).json({ success: false, code: 'API_OFFLINE', error: 'The API is temporarily offline.' });
  const creds = generatePiCredentials();
  const ref = db().collection('piClients').doc(req.uid);
  let regenerated = false; let blocked = false;
  await db().runTransaction(async (tx) => {
    blocked = false;
    const snap = await tx.get(ref);
    const old = snap.exists ? snap.data() : null;
    if (old?.disabled) { blocked = true; return; }
    regenerated = !!old;
    tx.set(ref, {
      uid: req.uid, email: req.userData.email || req.email || '',
      piKeyHash: creds.piKeyHash, prefix: creds.prefix, piKeyEnc: encryptSecret(creds.piKey),
      createdAt: old?.createdAt || Date.now(), regeneratedAt: old ? Date.now() : null,
      lastUsedAt: null, disabled: false,
    });
  });
  if (blocked) return res.status(403).json({ success: false, code: 'API_DISABLED', error: 'pi_key access for this account has been disabled. Please contact support.' });
  telegramNotify(`🔑 <b>PI KEY ${regenerated ? 'REGENERATED' : 'CREATED'}</b>\n✉️ ${esc(req.userData.email || req.email || '—')}\n🆔 <code>${esc(req.uid)}</code>`, 'reseller');
  res.json({ success: true, regenerated, piKey: creds.piKey, prefix: creds.prefix, revealable: canRevealKeys() });
}));

router.get('/pi/credentials/reveal', rateLimit({ windowMs: 60_000, max: 20, name: 'pi-reveal' }), asyncHandler(async (req, res) => {
  const snap = await db().collection('piClients').doc(req.uid).get();
  if (!snap.exists) return res.status(404).json({ success: false, code: 'NO_CREDENTIALS', error: 'Generate your pi_key first.' });
  const c = snap.data();
  if (c.disabled) return res.status(403).json({ success: false, code: 'API_DISABLED', error: 'pi_key access for this account has been disabled. Please contact support.' });
  const piKey = decryptSecret(c.piKeyEnc);
  if (!piKey) return res.status(409).json({ success: false, code: 'NOT_REVEALABLE', error: 'Your key can no longer be displayed. Tap Re-generate to get a new one.' });
  res.json({ success: true, piKey });
}));

export default router;
// src by SRT X CHEATS. Copy right SRT X CHEATS
