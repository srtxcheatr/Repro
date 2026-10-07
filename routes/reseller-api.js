// routes/reseller-api.js — the PUBLIC reseller API.
//
//   POST /api/reseller/v1
//   Header : x-master-key: <master key>
//   Body   : form-urlencoded OR JSON  { api_key, action, ... }
//
// Actions:  buy | balance | products
//
// "buy" flow (your store sits in the middle):
//   1. Authenticate the caller (api_key + master key; must be a live reseller).
//   2. Validate the request and find the product by product_id + duration.
//   3. Check maintenance / stock, then check the caller's balance.
//   4. DEBIT the balance atomically up front (one Firestore transaction —
//      two simultaneous orders can never spend the same money).
//   5. Buy the keys from the real (upstream) reseller.
//   6. REFUND the price of any key that could not be delivered.
//   7. Save the order and return the keys.
//
// The upstream call deliberately happens OUTSIDE any Firestore transaction.
// Transactions can be retried by Firestore; a retried transaction that
// contains a paid upstream purchase could buy the same key twice.
//
// No CORS headers on purpose: this is a server-to-server API (PHP / Node /
// Python), and browsers should not be able to call it from some random site.

import express from 'express';
import crypto from 'crypto';
import admin from 'firebase-admin';
import { asyncHandler } from '../src/asyncHandler.js';
import { db } from '../src/firebase.js';
import { rateLimit } from '../src/security.js';
import { getMaintenanceForSku } from '../src/catalog.js';
import { fetchRealKey } from '../src/upstream.js';
import { keyToString } from '../src/apiMatch.js';
import { authenticateClient, getApiSettings, touchLastUsed, sha256 } from '../src/apiClients.js';
import { listApiProducts, findApiProduct } from '../src/resellerApiCatalog.js';
import { telegramNotify, esc } from '../src/telegram.js';

const router = express.Router();
router.use(express.urlencoded({ extended: false, limit: '8kb' }));
router.use(rateLimit({ windowMs: 60_000, max: 120, name: 'reseller-api' }));

const MAX_QTY = 100;
const UPSTREAM_CONCURRENCY = Math.max(1, Math.min(8, parseInt(process.env.API_BUY_CONCURRENCY, 10) || 3));
// Stop STARTING new upstream purchases after this long, so the whole request
// finishes inside the ~100s the hosting proxy allows. Anything not bought by
// then is refunded, never left hanging.
const BUY_BUDGET_MS = 70_000;
const MAX_INFLIGHT_PER_CLIENT = 3;
const MAX_BUYS_PER_MINUTE = 30;

const inflight = new Map();   // uid -> orders currently running
const buyWindow = new Map();  // uid -> { startedAt, count }

const round2 = (n) => Math.round(n * 100) / 100;
const fail = (status, code, error, extra = {}) => ({ status, body: { success: false, code, error, ...extra } });

function allowBuyRate(uid) {
  const now = Date.now();
  let w = buyWindow.get(uid);
  if (!w || now - w.startedAt >= 60_000) { w = { startedAt: now, count: 0 }; buyWindow.set(uid, w); }
  w.count += 1;
  return w.count <= MAX_BUYS_PER_MINUTE;
}

// ============================================================
//  Shape of an order as sent back to the reseller
// ============================================================
function orderResponse(o, extra = {}) {
  const base = {
    order_id: o.orderId,
    status: o.status,
    product: { name: o.productRow, product_id: o.pid, duration: o.durationLabel },
    quantity_requested: o.quantity,
    quantity_delivered: o.delivered || 0,
    quantity_failed: o.failed || 0,
    unit_price: o.unitPrice,
    charged: o.charged || 0,
    refunded: o.refunded || 0,
    balance: o.balanceAfter,
    keys: o.keys || [],
    ...extra,
  };
  if (o.status === 'failed') {
    return fail(502, 'PROVIDER_UNAVAILABLE',
      'Could not get a key from the provider right now (product may be out of stock). You were not charged.', base);
  }
  return { status: 200, body: { success: true, partial: o.status === 'partial', ...base } };
}

// ============================================================
//  action = buy
// ============================================================
async function processBuy(auth, body) {
  // ---- 1. validate input ----
  const pid = String(body.product_id ?? '').trim();
  const durationIn = String(body.duration ?? '').trim();
  const qtyRaw = body.quantity === undefined || body.quantity === '' ? '1' : String(body.quantity).trim();
  const androidId = String(body.android_id ?? '').trim();
  const requestId = String(body.request_id ?? '').trim();

  if (!pid || pid.length > 64) return fail(400, 'INVALID_PRODUCT_ID', 'product_id is required.');
  if (!durationIn || durationIn.length > 80) return fail(400, 'INVALID_DURATION', 'duration is required, e.g. "1 Day".');
  if (!/^\d{1,3}$/.test(qtyRaw) || parseInt(qtyRaw, 10) < 1 || parseInt(qtyRaw, 10) > MAX_QTY) {
    return fail(400, 'INVALID_QUANTITY', `quantity must be a whole number from 1 to ${MAX_QTY}.`);
  }
  const quantity = parseInt(qtyRaw, 10);
  if (androidId && !/^[A-Za-z0-9_\-:.]{1,64}$/.test(androidId)) {
    return fail(400, 'INVALID_ANDROID_ID', 'android_id contains invalid characters.');
  }
  if (requestId && !/^[A-Za-z0-9_\-:.]{1,64}$/.test(requestId)) {
    return fail(400, 'INVALID_REQUEST_ID', 'request_id may only use letters, numbers and _ - : . (max 64).');
  }

  // ---- 2. find the product ----
  const found = await findApiProduct(pid, durationIn);
  if (found.error === 'NOT_FOUND') {
    return fail(404, 'PRODUCT_NOT_FOUND', 'No product matches that product_id + duration. Use action=products to see the exact values.');
  }
  if (found.error === 'AMBIGUOUS') {
    console.error(`[reseller-api] ambiguous product pid=${pid} duration=${durationIn} skus=${(found.skus || []).join(',')}`);
    return fail(409, 'PRODUCT_UNAVAILABLE', 'This product cannot be ordered through the API right now. Please contact support.');
  }
  const product = found.product;

  // ---- 3. stock / maintenance (fresh read — this gates real money) ----
  const live = await getMaintenanceForSku(product.sku);
  if (live.maintenance) {
    return fail(409, 'PRODUCT_MAINTENANCE', live.maintenanceMessage || 'This product is currently under maintenance.');
  }
  if (live.outOfStock) {
    return fail(409, 'OUT_OF_STOCK', live.outOfStockMessage || 'This duration is currently out of stock.');
  }
  if (product.requiresAndroidId && !androidId) {
    return fail(400, 'ANDROID_ID_REQUIRED', 'android_id is required for this product.');
  }

  const unitPrice = product.price;
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
    console.error(`[reseller-api] bad price for sku=${product.sku}: ${product.price}`);
    return fail(500, 'PRICE_ERROR', 'This product is not priced correctly. Please contact support.');
  }
  const total = round2(unitPrice * quantity);

  // ---- 4. per-reseller guards ----
  const uid = auth.uid;
  if (!allowBuyRate(uid)) return fail(429, 'RATE_LIMITED', 'Too many orders per minute. Slow down and retry shortly.');
  if ((inflight.get(uid) || 0) >= MAX_INFLIGHT_PER_CLIENT) {
    return fail(429, 'TOO_MANY_ACTIVE_ORDERS', 'You already have several orders being processed. Wait for them to finish.');
  }
  inflight.set(uid, (inflight.get(uid) || 0) + 1);

  try {
    // ---- 5. debit atomically (also the idempotency gate) ----
    const userRef = db().collection('users').doc(uid);
    const orderId = requestId ? `rid_${sha256(requestId).slice(0, 40)}` : `ord_${crypto.randomUUID().replace(/-/g, '')}`;
    const orderRef = userRef.collection('apiOrders').doc(orderId);

    const order = {
      orderId, via: 'api', sku: product.sku, productRow: product.row || product.name, productName: product.name,
      pid, durationLabel: product.label, upstreamDuration: product.duration, quantity, unitPrice,
      androidId: androidId || null, requestId: requestId || null,
      status: 'processing', keys: [], delivered: 0, failed: 0, charged: 0, refunded: 0,
      createdAt: Date.now(),
    };

    let replay = null;
    let balanceBefore = 0;
    let insufficient = null;

    await db().runTransaction(async (tx) => {
      replay = null; insufficient = null; // the callback can run more than once
      const [userSnap, orderSnap] = await Promise.all([tx.get(userRef), tx.get(orderRef)]);

      if (orderSnap.exists) { replay = orderSnap.data(); return; }

      const u = userSnap.exists ? userSnap.data() : {};
      if ((u.role || 'user') !== 'reseller' || u.requestStatus === 'Banned') {
        insufficient = { notAllowed: true };
        return;
      }
      const balance = Number(u.balance || 0);
      if (balance < total) { insufficient = { balance }; return; }

      balanceBefore = balance;
      order.balanceAfter = round2(balance - total);
      tx.update(userRef, { balance: order.balanceAfter });
      tx.set(orderRef, order);
    });

    if (replay) {
      // Same request_id seen before: never charge twice, just report what happened.
      if (replay.sku !== product.sku || replay.quantity !== quantity) {
        return fail(422, 'REQUEST_ID_REUSED', 'This request_id was already used for a different order. Use a new request_id.');
      }
      if (replay.status === 'processing') {
        return fail(409, 'ORDER_IN_PROGRESS', 'This order is still being processed. Retry in a few seconds with the same request_id.', { order_id: replay.orderId });
      }
      return orderResponse(replay, { idempotent_replay: true });
    }
    if (insufficient?.notAllowed) {
      return fail(403, 'NOT_RESELLER', 'The reseller API is only available to reseller accounts.');
    }
    if (insufficient) {
      return fail(402, 'INSUFFICIENT_BALANCE', `Not enough balance. This order costs NRP ${total}.`,
        { balance: round2(insufficient.balance), required: total });
    }

    // ---- 6. buy from the real reseller (outside any transaction) ----
    const { keys, failures } = await buyKeysFromUpstream({ product, quantity, androidId, orderRef });

    // ---- 7. settle: refund failures, record the order ----
    const delivered = keys.length;
    const failed = quantity - delivered;
    const refund = round2(failed * unitPrice);
    const charged = round2(delivered * unitPrice);
    const status = delivered === quantity ? 'completed' : delivered > 0 ? 'partial' : 'failed';
    const balanceAfter = round2(balanceBefore - total + refund);
    const finished = {
      status, keys, delivered, failed, charged, refunded: refund, balanceAfter, finishedAt: Date.now(),
      error: failures.length ? failures[0] : null,
    };

    try {
      const batch = db().batch();
      batch.update(userRef, {
        balance: admin.firestore.FieldValue.increment(refund),
        totalKeysBought: admin.firestore.FieldValue.increment(delivered),
        totalSpent: admin.firestore.FieldValue.increment(charged),
      });
      batch.update(orderRef, finished);
      await batch.commit();
    } catch (e) {
      // Keys were already bought upstream, so still hand them over — but shout
      // loudly, because the refund/record did not save and needs a human.
      console.error('[reseller-api] SETTLEMENT FAILED', orderId, e);
      telegramNotify(
        `🚨 <b>API ORDER SETTLEMENT FAILED — needs manual check</b>\n` +
        `Order: <code>${esc(orderId)}</code>\nUID: <code>${esc(uid)}</code>\n` +
        `Debited: NRP ${total} · delivered ${delivered}/${quantity} · refund owed: NRP ${refund}`, 'reseller');
    }

    notifyOrder({ auth, order, finished, total, balanceBefore });
    return orderResponse({ ...order, ...finished });
  } finally {
    const n = (inflight.get(uid) || 1) - 1;
    if (n <= 0) inflight.delete(uid); else inflight.set(uid, n);
  }
}

// ------------------------------------------------------------
// Buys `quantity` keys with a small worker pool.
//  - If the first few attempts ALL fail (upstream down / out of stock) the
//    rest are skipped instead of hammering a broken provider 100 times.
//  - Every key is also saved to the order document the moment it arrives, so
//    even if the server restarts mid-order the paid-for keys aren't lost.
// ------------------------------------------------------------
async function buyKeysFromUpstream({ product, quantity, androidId, orderRef }) {
  const keys = [];
  const failures = [];
  const saves = [];
  const deadline = Date.now() + BUY_BUDGET_MS;
  let next = 0;
  let abort = false;

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= quantity) return;
      if (abort || Date.now() > deadline) { failures.push(abort ? 'provider failing — remaining skipped' : 'time budget reached'); continue; }
      try {
        const key = keyToString(await fetchRealKey(product.sku, product, androidId || null));
        if (!key) throw new Error('empty key returned');
        keys.push(key);
        saves.push(orderRef.update({ keys: admin.firestore.FieldValue.arrayUnion(key) }).catch(() => {}));
      } catch (e) {
        failures.push(String(e?.message || e).slice(0, 200));
        if (keys.length === 0 && failures.length >= 3) abort = true;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(UPSTREAM_CONCURRENCY, quantity) }, worker));
  await Promise.allSettled(saves); // so the final write can't be overtaken by a late progress write
  return { keys, failures };
}

function notifyOrder({ auth, order, finished, total, balanceBefore }) {
  const icon = finished.status === 'completed' ? '✅' : finished.status === 'partial' ? '⚠️' : '❌';
  const lines = [
    `${icon} <b>API ORDER — ${esc(finished.status.toUpperCase())}</b>`,
    `✉️ ${esc(auth.user.email || '—')}`,
    `📦 ${esc(order.productRow)} · ${esc(order.durationLabel)} (pid ${esc(order.pid)})`,
    `🔢 ${finished.delivered}/${order.quantity} delivered · charged NRP ${finished.charged}` + (finished.refunded ? ` · refunded NRP ${finished.refunded}` : ''),
    `NRP :- ${esc(balanceBefore)} ➝ ${esc(finished.balanceAfter)}`,
    `🆔 <code>${esc(auth.uid)}</code> · <code>${esc(order.orderId)}</code>`,
  ];
  if (order.quantity <= 5 && finished.keys.length) lines.push(...finished.keys.map((k) => `🔑 <code>${esc(k)}</code>`));
  if (finished.error) lines.push(`📝 ${esc(finished.error)}`);
  telegramNotify(lines.join('\n'), 'reseller');
}

// ============================================================
//  Entry point
// ============================================================
router.post('/', asyncHandler(async (req, res) => {
  const send = (r) => res.status(r.status).json(r.body);

  const settings = await getApiSettings();
  if (!settings.enabled) return send(fail(503, 'API_OFFLINE', 'The reseller API is temporarily offline. Please try again later.'));

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const apiKey = String(body.api_key ?? req.headers['x-api-key'] ?? '').trim();
  const masterKey = String(req.headers['x-master-key'] ?? '').trim();

  const auth = await authenticateClient(apiKey, masterKey);
  if (!auth.ok) return send(fail(auth.status, auth.code, auth.error));
  touchLastUsed(auth.clientRef, auth.uid);

  const action = String(body.action ?? '').trim().toLowerCase();

  if (action === 'balance') {
    return res.json({ success: true, balance: round2(Number(auth.user.balance || 0)), currency: 'NRP' });
  }

  if (action === 'products') {
    const products = (await listApiProducts()).map((p) => ({
      product_name: p.row, product_id: p.pid, duration: p.label, price: p.price,
      status: p.status, requires_android_id: p.requiresAndroidId,
    }));
    return res.json({ success: true, currency: 'NRP', products });
  }

  if (action === 'buy') return send(await processBuy(auth, body));

  return send(fail(400, 'INVALID_ACTION', 'action must be one of: buy, balance, products.'));
}));

// A browser/GET visit gets a pointer instead of a bare 404.
router.all('/', (req, res) => {
  res.status(405).set('Allow', 'POST').json({
    success: false, code: 'METHOD_NOT_ALLOWED',
    error: 'Use POST with api_key in the body and x-master-key in the headers. See apicontact.php in your account for the full guide.',
  });
});

export default router;
