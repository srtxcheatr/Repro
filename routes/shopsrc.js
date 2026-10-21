// src by SRT X CHEATS. Copy right SRT X CHEATS
// "Shop project" product: buyer pays from store balance, gets the source code (protected download),
// then fills the registration form that is sent to the owner on Telegram.
import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import admin from 'firebase-admin';
import { asyncHandler } from '../src/asyncHandler.js';
import { db, requireFirebaseUid, userCors } from '../src/firebase.js';
import { getShopSrcProductRaw, getMaintenanceForSku } from '../src/srt_storage_product.js';
import { telegramNotify, telegramFormat, esc, formatNepaliDateTime } from '../src/telegram.js';
import { invalidateUserDoc } from '../src/userCache.js';
import { leaderboardCache } from '../src/sharedCaches.js';
import { uploadImage } from '../src/imgbb.js';
import { rateLimit } from '../src/security.js';
import {
  shopDomains, shopSrcPrice, cleanSub, MAX_SUBMITS, MAX_DOWNLOADS,
  signDownloadToken, verifyDownloadToken, consumeNonce,
} from '../src/shopSrc.js';

// ---------------------------------------------------------------- authed router (/api/shopsrc)
const router = express.Router();
router.use(userCors);
router.use(requireFirebaseUid);

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, extra });
const send = (res, e) => res.status(e.status || 500).json({ success: false, error: e.message, ...(e.extra || {}) });
const notifyShop = (text) => telegramNotify(text, 'purchase');
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

async function ownOrder(req) {
  const id = String(req.params.id || '').trim();
  if (!/^so_[a-z0-9_]{6,40}$/.test(id)) throw fail(404, 'Order not found');
  const ref = db().collection('shopOrders').doc(id);
  const snap = await ref.get();
  // same message for "missing" and "someone else's" so order ids cannot be probed
  if (!snap.exists || snap.data().uid !== req.uid) throw fail(404, 'Order not found');
  return { ref, id, data: snap.data() };
}

const lastBuy = new Map();

router.post('/buy', asyncHandler(async (req, res) => {
  const productId = String(req.body?.productId || '').trim();
  if (!productId) return res.status(400).json({ success: false, error: 'Missing product.' });

  const now = Date.now();
  if (now - (lastBuy.get(req.uid) || 0) < 5000) {
    return res.status(429).json({ success: false, error: 'Please wait a few seconds before trying again.' });
  }
  lastBuy.set(req.uid, now);

  try {
    const product = await getShopSrcProductRaw(productId);
    if (!product) throw fail(404, 'Unknown product');
    const live = await getMaintenanceForSku(productId);
    if (live.maintenance) throw fail(409, live.maintenanceMessage || 'This product is currently under maintenance.');
    if (live.outOfStock) throw fail(409, live.outOfStockMessage || 'This product is currently out of stock.');

    const userRef = db().collection('users').doc(req.uid);
    const orderId = `so_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
    const orderRef = db().collection('shopOrders').doc(orderId);

    // Balance debit + order + purchase history are one atomic write: either everything happens or nothing.
    const out = await db().runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) throw fail(404, 'Account not found. Please log in again.');
      const u = snap.data();
      if (Number(u.checkoutBanUntil || 0) > Date.now()) {
        throw fail(403, 'Too many purchase attempts with insufficient balance. Please wait before trying again.', { code: 'CHECKOUT_BANNED', bannedUntil: Number(u.checkoutBanUntil) });
      }
      const role = u.role || 'user';
      const price = shopSrcPrice(product, role);
      if (!price || price <= 0) throw fail(409, 'This product has no valid price. Contact support.');
      const balance = Number(u.balance || 0);
      if (balance < price) {
        throw fail(402, 'Not enough balance. Please top up first, then try again.', { code: 'INSUFFICIENT_BALANCE', balance, required: price });
      }
      const entry = {
        at: new Date().toISOString(), sku: productId, row: product.name, name: product.name, duration: 'Source code',
        price, key: `Shop project order ${orderId}`, type: 'shopsrc', orderId,
        buyerName: u.profileName || '', buyerWa: u.profilePhone || '',
      };
      const history = Array.isArray(u.purchaseHistory) ? [...u.purchaseHistory, entry] : [entry];
      tx.set(userRef, {
        balance: balance - price, purchaseHistory: history,
        totalSpent: admin.firestore.FieldValue.increment(price),
      }, { merge: true });
      tx.set(orderRef, {
        uid: req.uid, email: u.email || req.email || '', productId, productName: product.name, price, role,
        status: 'paid', createdAt: Date.now(), downloads: 0, submitCount: 0, submitted: false,
      });
      return { price, newBalance: balance - price, balanceBefore: balance, entry, u };
    });

    try { invalidateUserDoc(req.uid); leaderboardCache.invalidate(); } catch (e) { console.error('[shopsrc] cache invalidate failed', e?.message || e); }

    notifyShop(telegramFormat('Shop project purchased', {
      username: out.u.profileName || req.email, email: out.u.email || req.email, phone: out.u.profilePhone || '',
      product: product.name, duration: 'Source code', price: out.price, uid: req.uid, status: 'success',
      balanceBefore: out.balanceBefore, balanceAfter: out.newBalance,
      others: `order ${orderId} — waiting for the buyer to fill the registration form`,
    }));

    res.json({ success: true, orderId, newBalance: out.newBalance, entry: out.entry });
  } catch (e) {
    lastBuy.delete(req.uid); // a failed attempt must not lock the buyer out for 5 s
    if (!e.status) console.error('[shopsrc] buy failed:', e);
    send(res, e.status ? e : fail(500, 'Purchase failed. Nothing was charged — please try again.'));
  }
}));

// Everything the registration page needs.
router.get('/order/:id', asyncHandler(async (req, res) => {
  try {
    const { id, data: o } = await ownOrder(req);
    res.json({
      success: true, id, productName: o.productName, price: o.price, status: o.status,
      submitted: !!o.submitted, submitCount: o.submitCount || 0, maxSubmits: MAX_SUBMITS,
      downloadsLeft: Math.max(0, MAX_DOWNLOADS - Number(o.downloads || 0)), maxDownloads: MAX_DOWNLOADS,
      domains: shopDomains(),
      logoUrl: o.logoUrl || '',
      details: o.details || null,
    });
  } catch (e) { send(res, e); }
}));

// Logo: the page sends the picked image (already shrunk in the browser); we put it on imgbb and keep the URL.
const lastLogo = new Map();
router.post('/logo/:id', asyncHandler(async (req, res) => {
  try {
    const { ref, id } = await ownOrder(req);
    const now = Date.now();
    if (now - (lastLogo.get(req.uid) || 0) < 4000) throw fail(429, 'Please wait a few seconds before uploading again.');
    lastLogo.set(req.uid, now);
    let url;
    try { url = await uploadImage(String(req.body?.image || ''), `shoplogo_${id}`); }
    catch (e) { lastLogo.delete(req.uid); throw fail(e.status || 502, e.message); }
    await ref.set({ logoUrl: url }, { merge: true });
    res.json({ success: true, logoUrl: url });
  } catch (e) { send(res, e); }
}));

router.post('/order/:id/submit', rateLimit({ windowMs: 60_000, max: 10, name: 'shopsrc-submit' }), asyncHandler(async (req, res) => {
  try {
    const { ref, id, data: o } = await ownOrder(req);
    if (o.status !== 'paid') throw fail(409, 'This order is not active.');
    if ((o.submitCount || 0) >= MAX_SUBMITS) throw fail(409, `You already submitted ${MAX_SUBMITS} times. Contact support on WhatsApp to change details.`);

    const b = req.body || {};
    const name = clean(b.name, 60);
    const number = clean(b.number, 20);
    const email = clean(b.email, 100).toLowerCase();
    const shopName = clean(b.shopName, 40);
    const resellerApi = clean(b.resellerApi, 300);
    const masterKey = clean(b.resellerMasterKey, 300);

    if (name.length < 2) throw fail(400, 'Enter your name.');
    if (number.replace(/\D/g, '').length < 7 || !/^[+\d][\d\s-]{5,}$/.test(number)) throw fail(400, 'Enter a valid phone / WhatsApp number.');
    if (!/^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw fail(400, 'Enter a valid email address.');
    if (shopName.length < 2) throw fail(400, 'Enter the admin panel shop name.');
    if (resellerApi.length < 4) throw fail(400, 'Enter your reseller API.');
    if (masterKey.length < 4) throw fail(400, 'Enter your reseller master key.');
    if (!o.logoUrl) throw fail(400, 'Pick a logo first (it is uploaded automatically).');

    let shopSub, adminSub;
    try {
      shopSub = cleanSub(b.shopSub?.name, b.shopSub?.domain, 'Shop subdomain');
      adminSub = cleanSub(b.adminSub?.name, b.adminSub?.domain, 'Admin panel subdomain');
    } catch (e) { throw fail(400, e.message); }
    if (shopSub.full === adminSub.full) throw fail(400, 'Shop and admin panel need two different subdomains.');

    const details = {
      name, number, email, shopName, resellerApi, resellerMasterKey: masterKey,
      shopSub: { name: shopSub.name, domain: shopSub.domain }, adminSub: { name: adminSub.name, domain: adminSub.domain },
    };

    // Reserve both domains in one transaction so two buyers can never get the same one.
    await db().runTransaction(async (tx) => {
      const fresh = await tx.get(ref);
      const cur = fresh.data() || {};
      if ((cur.submitCount || 0) >= MAX_SUBMITS) throw fail(409, `You already submitted ${MAX_SUBMITS} times.`);
      const wanted = [shopSub.full, adminSub.full];
      const refs = wanted.map((d) => db().collection('shopDomains').doc(d));
      const snaps = await Promise.all(refs.map((r) => tx.get(r)));
      snaps.forEach((s, i) => {
        if (s.exists && s.data().orderId !== id) throw fail(409, `${wanted[i]} is already taken — choose another subdomain.`);
      });
      // free the domains this order reserved on an earlier submit and no longer wants
      for (const old of [cur.details?.shopSub, cur.details?.adminSub].filter(Boolean)) {
        const full = `${old.name}.${old.domain}`;
        if (!wanted.includes(full)) tx.delete(db().collection('shopDomains').doc(full));
      }
      refs.forEach((r) => tx.set(r, { orderId: id, uid: req.uid, at: Date.now() }));
      tx.set(ref, { details, submitted: true, submitCount: (cur.submitCount || 0) + 1, submittedAt: Date.now() }, { merge: true });
    });

    const again = (o.submitCount || 0) > 0;
    const lines = [
      `🛒 <b>${again ? 'SHOP PROJECT — UPDATED DETAILS' : 'NEW SHOP PROJECT ORDER'}</b>`,
      `📦 ${esc(o.productName)} — Rs ${esc(o.price)}`,
      '━━━━━━━━━━━━━━',
      `YOUR NAME - ${esc(name)}`,
      `YOUR NUMBER - ${esc(number)}`,
      `YOUR EMAIL - ${esc(email)}`,
      '━━━━━━━━━━━━━━',
      `ADMIN PANEL SHOP NAME - ${esc(shopName)}`,
      '',
      `SUBDOMAIN for shop - <code>${esc(shopSub.full)}</code>`,
      `SUBDOMAIN FOR ADMINPANEL CONTROL - <code>${esc(adminSub.full)}</code>`,
      '━━━━━━━━━━━━━━',
      `Logo = ${esc(o.logoUrl)}`,
      '',
      `Your reseller api - <code>${esc(resellerApi)}</code>`,
      `Your reseller master key - <code>${esc(masterKey)}</code>`,
      '━━━━━━━━━━━━━━',
      `🧾 Order <code>${esc(id)}</code> · submit ${(o.submitCount || 0) + 1}/${MAX_SUBMITS}`,
      `🆔 <code>${esc(req.uid)}</code>`,
      `📅 ${esc(formatNepaliDateTime())}`,
    ];
    notifyShop(lines.join('\n'));

    res.json({ success: true, submitCount: (o.submitCount || 0) + 1, maxSubmits: MAX_SUBMITS });
  } catch (e) {
    if (!e.status) console.error('[shopsrc] submit failed:', e);
    send(res, e.status ? e : fail(500, 'Could not save your details. Please try again.'));
  }
}));

// Step 1 of the protected download: only the paying owner gets a short-lived signed link.
router.post('/order/:id/download-link', rateLimit({ windowMs: 60_000, max: 12, name: 'shopsrc-dl-link' }), asyncHandler(async (req, res) => {
  try {
    const { id, data: o } = await ownOrder(req);
    if (o.status !== 'paid') throw fail(409, 'This order is not active.');
    if (Number(o.downloads || 0) >= MAX_DOWNLOADS) throw fail(403, 'Download limit reached. Contact support on WhatsApp.');
    const token = signDownloadToken({ orderId: id, uid: req.uid });
    res.json({ success: true, url: `/api/shopsrc-file/download/${token}`, expiresInSec: 90 });
  } catch (e) { send(res, e.status ? e : fail(500, 'Could not create the download link.')); }
}));

// ---------------------------------------------------------------- file router (/api/shopsrc-file)
// No login header here (it is a plain browser navigation) - the signed single-use token IS the proof of payment.
export const fileRouter = express.Router();

async function openSource() {
  const url = process.env.SHOPSRC_FILE_URL;
  if (url) {
    const headers = { Accept: 'application/octet-stream' };
    if (process.env.SHOPSRC_FILE_AUTH) headers.Authorization = process.env.SHOPSRC_FILE_AUTH; // e.g. "Bearer ghp_xxx" for a private GitHub release
    const r = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
    if (!r.ok || !r.body) throw new Error(`source host answered HTTP ${r.status}`);
    return { stream: Readable.fromWeb(r.body), length: r.headers.get('content-length') };
  }
  const file = path.resolve(process.env.SHOPSRC_FILE_PATH || 'private/shop-src.zip');
  const st = await fs.promises.stat(file); // throws if missing
  return { stream: fs.createReadStream(file), length: String(st.size) };
}

fileRouter.get('/download/:token', rateLimit({ windowMs: 60_000, max: 20, name: 'shopsrc-dl' }), asyncHandler(async (req, res) => {
  const t = verifyDownloadToken(req.params.token);
  if (!t) return res.status(403).type('text/plain').send('This download link is invalid or expired. Go back and press Download again.');
  if (!consumeNonce(t.n)) return res.status(403).type('text/plain').send('This download link was already used. Go back and press Download again.');

  const ref = db().collection('shopOrders').doc(t.o);
  let order;
  try {
    // count the download before sending a single byte; refunded below if the stream never starts
    order = await db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const o = snap.exists ? snap.data() : null;
      if (!o || o.uid !== t.u || o.status !== 'paid') throw fail(403, 'No paid order for this link.');
      if (Number(o.downloads || 0) >= MAX_DOWNLOADS) throw fail(403, 'Download limit reached. Contact support on WhatsApp.');
      tx.update(ref, { downloads: admin.firestore.FieldValue.increment(1), lastDownloadAt: Date.now(), lastDownloadIp: String(req.ip || '') });
      return o;
    });
  } catch (e) {
    return res.status(e.status || 500).type('text/plain').send(e.message);
  }

  let src;
  try { src = await openSource(); }
  catch (e) {
    console.error('[shopsrc] source file unavailable:', e?.message || e);
    ref.update({ downloads: admin.firestore.FieldValue.increment(-1) }).catch(() => {});
    telegramNotify(`🔥 <b>Shop source file unavailable</b>\norder <code>${esc(t.o)}</code>\n${esc(String(e?.message || e).slice(0, 200))}\nCheck SHOPSRC_FILE_URL / SHOPSRC_FILE_PATH.`, 'health');
    return res.status(503).type('text/plain').send('The source file is temporarily unavailable. Nothing was counted — please try again in a minute or contact support.');
  }

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${(process.env.SHOPSRC_FILE_NAME || 'srtx-shop-source.zip').replace(/[^\w.\-]/g, '_')}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (src.length) res.setHeader('Content-Length', src.length);
  try {
    await pipeline(src.stream, res);
    if (Number(order.downloads || 0) === 0) {
      notifyShop(`📥 <b>Shop source downloaded</b>\norder <code>${esc(t.o)}</code> · ${esc(order.productName)}\n🆔 <code>${esc(t.u)}</code>`);
    }
  } catch (e) {
    // client dropped mid-way: give the attempt back so a bad connection does not burn the limit
    ref.update({ downloads: admin.firestore.FieldValue.increment(-1) }).catch(() => {});
  }
}));

export default router;
