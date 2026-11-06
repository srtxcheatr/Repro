// src by SRT X CHEATS. Copy right SRT X CHEATS
// PI KEY API — product import. Read-only: returns product name, image, pid and every duration.
// Prices are the caller's own tier price (user / reseller / pro_reseller) + PI_MARKUP_PERCENT (default 30%).
import express from 'express';
import { asyncHandler } from '../src/asyncHandler.js';
import { rateLimit } from '../src/security.js';
import { authenticatePiKey, getApiSettings } from '../src/apiClients.js';
import { listPiProducts, PI_MARKUP_PERCENT } from '../src/resellerApiCatalog.js';
import { activeBan } from '../src/ban.js';

const router = express.Router();
router.use(express.urlencoded({ extended: false, limit: '8kb' }));
router.use(express.json({ limit: '8kb' }));
router.use(rateLimit({ windowMs: 60_000, max: 60, name: 'pi-api' }));

const fail = (res, status, code, error) => res.status(status).json({ success: false, code, error });
const lastTouch = new Map();

router.post('/', asyncHandler(async (req, res) => {
  const settings = await getApiSettings();
  if (!settings.enabled) return fail(res, 503, 'API_OFFLINE', 'The API is temporarily offline. Please try again later.');

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const piKey = String(body.pi_key ?? req.headers['x-pi-key'] ?? '').trim();

  const auth = await authenticatePiKey(piKey);
  if (!auth.ok) return fail(res, auth.status, auth.code, auth.error);
  if (activeBan(auth.user)) return fail(res, 403, 'BANNED', 'Your account has been banned by admin.');

  const now = Date.now();
  if (now - (lastTouch.get(auth.uid) || 0) > 60_000) {
    lastTouch.set(auth.uid, now);
    auth.clientRef.update({ lastUsedAt: now }).catch(() => {});
  }

  const action = String(body.action ?? 'products').trim().toLowerCase();
  if (action !== 'products') return fail(res, 400, 'INVALID_ACTION', 'action must be: products.');

  const role = auth.user.role || 'user';
  const products = await listPiProducts(role);
  res.json({ success: true, currency: 'NRP', role, markup_percent: PI_MARKUP_PERCENT, count: products.length, products });
}));

router.all('/', (req, res) => {
  res.status(405).set('Allow', 'POST').json({
    success: false, code: 'METHOD_NOT_ALLOWED',
    error: 'Use POST with pi_key in the body (or x-pi-key header). See the PI Key page in your account.',
  });
});

export default router;
