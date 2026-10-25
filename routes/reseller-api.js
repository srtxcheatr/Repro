// src by SRT X CHEATS. Copy right SRT X CHEATS
import { isResellerTier } from '../src/proTier.js';
import express from 'express';
import crypto from 'crypto';
// src by SRT X CHEATS. Copy right SRT X CHEATS
import admin from 'firebase-admin';
import { asyncHandler } from '../src/asyncHandler.js';
import { db } from '../src/firebase.js';
import { rateLimit } from '../src/security.js';
import { invalidateUserDoc } from '../src/userCache.js';
// src by SRT X CHEATS. Copy right SRT X CHEATS
import { getMaintenanceForSku } from '../src/srt_storage_product.js';
import { fetchRealKey } from '../src/upstream.js';
import { keyToString } from '../src/apiMatch.js';
import { authenticateClient, getApiSettings, touchLastUsed, sha256 } from '../src/apiClients.js';
import { listApiProducts, findApiProduct } from '../src/resellerApiCatalog.js';
// src by SRT X CHEATS. Copy right SRT X CHEATS
import { telegramNotify, esc } from '../src/telegram.js';
import { activeBan } from '../src/ban.js';

const router = express.Router();
router.use(express.urlencoded({ extended: false, limit: '8kb' }));
// src by SRT X CHEATS. Copy right SRT X CHEATS
router.use(rateLimit({ windowMs: 60_000, max: 120, name: 'reseller-api' }));

const MAX_QTY = 100;
const UPSTREAM_CONCURRENCY = Math.max(1, Math.min(8, parseInt(process.env.API_BUY_CONCURRENCY, 10) || 3));
const BUY_BUDGET_MS = 70_000;
// src by SRT X CHEATS. Copy right SRT X CHEATS
const MAX_INFLIGHT_PER_CLIENT = 3;
const MAX_BUYS_PER_MINUTE = 30;

const inflight = new Map();
const buyWindow = new Map();
// src by SRT X CHEATS. Copy right SRT X CHEATS

const round2 = (n) => Math.round(n * 100) / 100;
const fail = (status, code, error, extra = {}) => ({ status, body: { success: false, code, error, ...extra } });

function allowBuyRate(uid) {
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const now = Date.now();
  let w = buyWindow.get(uid);
  if (!w || now - w.startedAt >= 60_000) { w = { startedAt: now, count: 0 }; buyWindow.set(uid, w); }
  w.count += 1;
  return w.count <= MAX_BUYS_PER_MINUTE;
// src by SRT X CHEATS. Copy right SRT X CHEATS
}

function orderResponse(o, extra = {}) {
  const base = {
    order_id: o.orderId,
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    status: o.status,
    product: { name: o.productRow, product_id: o.pid, duration: o.durationLabel },
    quantity_requested: o.quantity,
    quantity_delivered: o.delivered || 0,
    quantity_failed: o.failed || 0,
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    unit_price: o.unitPrice,
    charged: o.charged || 0,
    refunded: o.refunded || 0,
    balance: o.balanceAfter,
    keys: o.keys || [],
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    ...extra,
  };
  if (o.status === 'failed') {
    return fail(502, 'PROVIDER_UNAVAILABLE',
      'Could not get a key from the provider right now (product may be out of stock). You were not charged.', base);
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  }
  return { status: 200, body: { success: true, partial: o.status === 'partial', ...base } };
}

async function processBuy(auth, body) {
  const priceRole = auth.user.role || 'reseller'; // price tier used for this order
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const pid = String(body.product_id ?? '').trim();
  const durationIn = String(body.duration ?? '').trim();
  const qtyRaw = body.quantity === undefined || body.quantity === '' ? '1' : String(body.quantity).trim();
  const androidId = String(body.android_id ?? '').trim();
  const requestId = String(body.request_id ?? '').trim();
// src by SRT X CHEATS. Copy right SRT X CHEATS

  if (!pid || pid.length > 64) return fail(400, 'INVALID_PRODUCT_ID', 'product_id is required.');
  if (!durationIn || durationIn.length > 80) return fail(400, 'INVALID_DURATION', 'duration is required, e.g. "1 Day".');
  if (!/^\d{1,3}$/.test(qtyRaw) || parseInt(qtyRaw, 10) < 1 || parseInt(qtyRaw, 10) > MAX_QTY) {
    return fail(400, 'INVALID_QUANTITY', `quantity must be a whole number from 1 to ${MAX_QTY}.`);
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  }
  const quantity = parseInt(qtyRaw, 10);
  if (androidId && !/^[A-Za-z0-9_\-:.]{1,64}$/.test(androidId)) {
    return fail(400, 'INVALID_ANDROID_ID', 'android_id contains invalid characters.');
  }
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (requestId && !/^[A-Za-z0-9_\-:.]{1,64}$/.test(requestId)) {
    return fail(400, 'INVALID_REQUEST_ID', 'request_id may only use letters, numbers and _ - : . (max 64).');
  }

  const found = await findApiProduct(pid, durationIn, priceRole);
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (found.error === 'NOT_FOUND') {
    return fail(404, 'PRODUCT_NOT_FOUND', 'No product matches that product_id + duration. Use action=products to see the exact values.');
  }
  if (found.error === 'AMBIGUOUS') {
    console.error(`[reseller-api] ambiguous product pid=${pid} duration=${durationIn} skus=${(found.skus || []).join(',')}`);
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    return fail(409, 'PRODUCT_UNAVAILABLE', 'This product cannot be ordered through the API right now. Please contact support.');
  }
  const product = found.product;

  const live = await getMaintenanceForSku(product.sku);
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (live.maintenance) {
    return fail(409, 'PRODUCT_MAINTENANCE', live.maintenanceMessage || 'This product is currently under maintenance.');
  }
  if (live.outOfStock) {
    return fail(409, 'OUT_OF_STOCK', live.outOfStockMessage || 'This duration is currently out of stock.');
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  }
  if (product.requiresAndroidId && !androidId) {
    return fail(400, 'ANDROID_ID_REQUIRED', 'android_id is required for this product.');
  }

  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const unitPrice = product.price;
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
    console.error(`[reseller-api] bad price for sku=${product.sku}: ${product.price}`);
    return fail(500, 'PRICE_ERROR', 'This product is not priced correctly. Please contact support.');
  }
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const total = round2(unitPrice * quantity);

  const uid = auth.uid;
  if (!allowBuyRate(uid)) return fail(429, 'RATE_LIMITED', 'Too many orders per minute. Slow down and retry shortly.');
  if ((inflight.get(uid) || 0) >= MAX_INFLIGHT_PER_CLIENT) {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    return fail(429, 'TOO_MANY_ACTIVE_ORDERS', 'You already have several orders being processed. Wait for them to finish.');
  }
  inflight.set(uid, (inflight.get(uid) || 0) + 1);

  try {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    const userRef = db().collection('users').doc(uid);
    const orderId = requestId ? `rid_${sha256(requestId).slice(0, 40)}` : `ord_${crypto.randomUUID().replace(/-/g, '')}`;
    const orderRef = userRef.collection('apiOrders').doc(orderId);

    const order = {
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      orderId, via: 'api', sku: product.sku, productRow: product.row || product.name, productName: product.name,
      pid, durationLabel: product.label, upstreamDuration: product.duration, quantity, unitPrice,
      androidId: androidId || null, requestId: requestId || null,
      status: 'processing', keys: [], delivered: 0, failed: 0, charged: 0, refunded: 0,
      createdAt: Date.now(),
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    };

    let replay = null;
    let balanceBefore = 0;
    let insufficient = null;
// src by SRT X CHEATS. Copy right SRT X CHEATS

    await db().runTransaction(async (tx) => {
      replay = null; insufficient = null;
      const [userSnap, orderSnap] = await Promise.all([tx.get(userRef), tx.get(orderRef)]);

      // src by SRT X CHEATS. Copy right SRT X CHEATS
      if (orderSnap.exists) { replay = orderSnap.data(); return; }

      const u = userSnap.exists ? userSnap.data() : {};
      if (!isResellerTier(u.role || 'user') || u.requestStatus === 'Banned') {
        insufficient = { notAllowed: true };
        // src by SRT X CHEATS. Copy right SRT X CHEATS
        return;
      }
      // Role changed (e.g. reseller -> pro) between auth and debit: never charge a stale tier price.
      if ((u.role || 'user') !== priceRole) { insufficient = { roleChanged: true }; return; }
      const balance = Number(u.balance || 0);
      if (balance < total) { insufficient = { balance }; return; }

      // src by SRT X CHEATS. Copy right SRT X CHEATS
      balanceBefore = balance;
      order.balanceBefore = round2(balance);
      order.balanceAfter = round2(balance - total);
      tx.update(userRef, { balance: order.balanceAfter });
      tx.set(orderRef, order);
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    });

    if (replay) {
      if (replay.sku !== product.sku || replay.quantity !== quantity) {
        return fail(422, 'REQUEST_ID_REUSED', 'This request_id was already used for a different order. Use a new request_id.');
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      }
      if (replay.status === 'processing') {
        return fail(409, 'ORDER_IN_PROGRESS', 'This order is still being processed. Retry in a few seconds with the same request_id.', { order_id: replay.orderId });
      }
      return orderResponse(replay, { idempotent_replay: true });
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    }
    if (insufficient?.notAllowed) {
      return fail(403, 'NOT_RESELLER', 'The reseller API is only available to reseller accounts.');
    }
    if (insufficient?.roleChanged) {
      return fail(409, 'ROLE_CHANGED', 'Your account tier changed while ordering. Please retry so the correct price is applied.');
    }
    if (insufficient) {
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      return fail(402, 'INSUFFICIENT_BALANCE', `Not enough balance. This order costs NRP ${total}.`,
        { balance: round2(insufficient.balance), required: total });
    }

    const { keys, failures } = await buyKeysFromUpstream({ product, quantity, androidId, orderRef });
// src by SRT X CHEATS. Copy right SRT X CHEATS

    const delivered = keys.length;
    const failed = quantity - delivered;
    const refund = round2(failed * unitPrice);
    const charged = round2(delivered * unitPrice);
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    const status = delivered === quantity ? 'completed' : delivered > 0 ? 'partial' : 'failed';
    const balanceAfter = round2(balanceBefore - total + refund);
    const finished = {
      status, keys, delivered, failed, charged, refunded: refund, balanceAfter, finishedAt: Date.now(),
      error: failures.length ? failures[0] : null,
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    };

    try {
      const batch = db().batch();
      batch.set(userRef, {
        // src by SRT X CHEATS. Copy right SRT X CHEATS
        balance: admin.firestore.FieldValue.increment(refund),
        totalKeysBought: admin.firestore.FieldValue.increment(delivered),
        totalSpent: admin.firestore.FieldValue.increment(charged),
      }, { merge: true });
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      batch.update(orderRef, finished);
      await batch.commit();
    } catch (e) {
      console.error('[reseller-api] SETTLEMENT FAILED', orderId, e);
      telegramNotify(
        // src by SRT X CHEATS. Copy right SRT X CHEATS
        `🚨 <b>API ORDER SETTLEMENT FAILED — needs manual check</b>\n` +
        `Order: <code>${esc(orderId)}</code>\nUID: <code>${esc(uid)}</code>\n` +
        `Debited: NRP ${total} · delivered ${delivered}/${quantity} · refund owed: NRP ${refund}`, 'reseller');
    }

    // src by SRT X CHEATS. Copy right SRT X CHEATS
    notifyOrder({ auth, order, finished, total, balanceBefore });
    return orderResponse({ ...order, ...finished });
  } finally {
    invalidateUserDoc(uid);
    const n = (inflight.get(uid) || 1) - 1;
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    if (n <= 0) inflight.delete(uid); else inflight.set(uid, n);
  }
}

async function buyKeysFromUpstream({ product, quantity, androidId, orderRef }) {
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const keys = [];
  const failures = [];
  const saves = [];
  const deadline = Date.now() + BUY_BUDGET_MS;
  let next = 0;
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  let abort = false;

  async function worker() {
    for (;;) {
      const i = next++;
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      if (i >= quantity) return;
      if (abort || Date.now() > deadline) { failures.push(abort ? 'provider failing — remaining skipped' : 'time budget reached'); continue; }
      try {
        const key = keyToString(await fetchRealKey(product.sku, product, androidId || null));
        if (!key) throw new Error('empty key returned');
        // src by SRT X CHEATS. Copy right SRT X CHEATS
        keys.push(key);
        saves.push(orderRef.update({ keys: admin.firestore.FieldValue.arrayUnion(key) }).catch(() => {}));
      } catch (e) {
        failures.push(String(e?.message || e).slice(0, 200));
        if (keys.length === 0 && failures.length >= 3) abort = true;
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(UPSTREAM_CONCURRENCY, quantity) }, worker));
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  await Promise.allSettled(saves);
  return { keys, failures };
}

function notifyOrder({ auth, order, finished, total, balanceBefore }) {
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const icon = finished.status === 'completed' ? '✅' : finished.status === 'partial' ? '⚠️' : '❌';
  const lines = [
    `${icon} <b>API ORDER — ${esc(finished.status.toUpperCase())}</b>`,
    `✉️ ${esc(auth.user.email || '—')}`,
    `📦 ${esc(order.productRow)} · ${esc(order.durationLabel)} (pid ${esc(order.pid)})`,
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    `🔢 ${finished.delivered}/${order.quantity} delivered · charged NRP ${finished.charged}` + (finished.refunded ? ` · refunded NRP ${finished.refunded}` : ''),
    `NRP :- ${esc(balanceBefore)} ➝ ${esc(finished.balanceAfter)}`,
    `🆔 <code>${esc(auth.uid)}</code> · <code>${esc(order.orderId)}</code>`,
  ];
  if (order.quantity <= 5 && finished.keys.length) lines.push(...finished.keys.map((k) => `🔑 <code>${esc(k)}</code>`));
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (finished.error) lines.push(`📝 ${esc(finished.error)}`);
  telegramNotify(lines.join('\n'), 'reseller');
}

router.post('/', asyncHandler(async (req, res) => {
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const send = (r) => res.status(r.status).json(r.body);

  const settings = await getApiSettings();
  if (!settings.enabled) return send(fail(503, 'API_OFFLINE', 'The reseller API is temporarily offline. Please try again later.'));

  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const apiKey = String(body.api_key ?? req.headers['x-api-key'] ?? '').trim();
  const masterKey = String(req.headers['x-master-key'] ?? '').trim();

  const auth = await authenticateClient(apiKey, masterKey);
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (!auth.ok) return send(fail(auth.status, auth.code, auth.error));
  if (activeBan(auth.user)) return send(fail(403, 'BANNED', 'Your account has been banned by admin.'));
  touchLastUsed(auth.clientRef, auth.uid);

  const action = String(body.action ?? '').trim().toLowerCase();
// src by SRT X CHEATS. Copy right SRT X CHEATS

  if (action === 'balance') {
    return res.json({ success: true, balance: round2(Number(auth.user.balance || 0)), currency: 'NRP' });
  }

  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (action === 'products') {
    const products = (await listApiProducts(auth.user.role || 'reseller')).map((p) => ({
      product_name: p.row, product_id: p.pid, duration: p.label, price: p.price,
      status: p.status, requires_android_id: p.requiresAndroidId,
    }));
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    return res.json({ success: true, currency: 'NRP', products });
  }

  if (action === 'buy') return send(await processBuy(auth, body));

  // src by SRT X CHEATS. Copy right SRT X CHEATS
  return send(fail(400, 'INVALID_ACTION', 'action must be one of: buy, balance, products.'));
}));

router.all('/', (req, res) => {
  res.status(405).set('Allow', 'POST').json({
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    success: false, code: 'METHOD_NOT_ALLOWED',
    error: 'Use POST with api_key in the body and x-master-key in the headers. See apicontact.php in your account for the full guide.',
  });
});

// src by SRT X CHEATS. Copy right SRT X CHEATS
export default router;
