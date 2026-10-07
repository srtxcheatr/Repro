import express from 'express';
import crypto from 'crypto';
import { asyncHandler } from '../src/asyncHandler.js';
import { db, requireAdmin, adminCors } from '../src/firebase.js';
import { rateLimit } from '../src/security.js';
import { CATALOG, CATALOG_RESELLER, getMaintenanceOverrides, invalidateMaintenanceCache, getLiveCatalog, invalidateCustomProductCache, findCustomProductFresh, getCustomProductRaw, deleteCustomProduct, invalidateWhatsappProductCache, getWhatsappProductRaw, deleteWhatsappProduct } from '../src/catalog.js';
import { telegramNotify, telegramFormat } from '../src/telegram.js';
import { notifyBalanceChange } from '../src/balanceAlerts.js';
import { normDuration, apiLabel, API_DURATION_RE, findLabelConflict } from '../src/apiMatch.js';
import { loadPidProducts } from '../src/resellerApiCatalog.js';
import { getApiSettings, setApiEnabled } from '../src/apiClients.js';

const router = express.Router();
router.use(adminCors);
// Tighter than the generic 180/min API-wide limit — this whole router
// moves money and account state, so it's worth its own ceiling. The
// real defense is still ADMIN_SECRET's own entropy (no rate limit makes
// guessing a long random secret feasible); this mainly bounds the blast
// radius of a leaked/compromised admin client going haywire.
router.use(rateLimit({ windowMs: 60_000, max: 90, name: 'admin' }));
router.use(requireAdmin);

const EMPTY_USER = (uid, email = '') => ({
  success: true, uid, found: false,
  balance: 0, email, adminLog: [], purchases: [],
  topupRequests: [], requestStatus: 'Active', adminMessage: '',
  profileName: '', profilePhone: '', role: 'user',
});

// GET /api/admin/lookup?uid=... or ?email=...
router.get('/lookup', asyncHandler(async (req, res) => {
  const uidParam = String(req.query.uid || '').trim();
  const emailParam = String(req.query.email || '').trim();
  if (!uidParam && !emailParam) {
    return res.status(400).json({ success: false, error: 'Provide a uid or email' });
  }

  let uid = uidParam;
  let snap;

  if (uid) {
    snap = await db().collection('users').doc(uid).get();
  } else {
    const q = await db().collection('users').where('email', '==', emailParam).limit(1).get();
    if (q.empty) return res.json(EMPTY_USER('', emailParam));
    snap = q.docs[0];
    uid = snap.id;
  }

  if (!snap.exists) return res.json(EMPTY_USER(uid));

  const data = snap.data();
  res.json({
    success: true, uid, found: true,
    balance: Number(data.balance || 0),
    email: data.email || '',
    adminLog: [...(data.adminLog || [])].reverse().slice(0, 50),
    purchases: [...(data.purchaseHistory || [])].reverse().slice(0, 50),
    topupRequests: [...(data.topupRequests || [])].reverse().slice(0, 50),
    requestStatus: data.requestStatus || 'Active',
    adminMessage: data.adminMessage || '',
    profileName: data.profileName || '',
    profilePhone: data.profilePhone || '',
    role: data.role || 'user',
  });
}));

// POST /api/admin/set-role  { uid, role: "user"|"reseller" }
// Changes which catalog/prices a user sees and can check out at.
// 'user' -> CATALOG (retail/high price), 'reseller' -> CATALOG_RESELLER
// (your custom reseller price). Takes effect immediately — the
// storefront reads role fresh from Firestore on every /api/user/catalog
// and /api/purchase/checkout call, so nothing needs re-login.
router.post('/set-role', asyncHandler(async (req, res) => {
  const uid = String(req.body?.uid || '').trim();
  const role = String(req.body?.role || '').trim();

  if (!uid) return res.status(400).json({ success: false, error: 'Provide a uid' });
  if (!['user', 'reseller'].includes(role)) {
    return res.status(400).json({ success: false, error: 'role must be "user" or "reseller"' });
  }

  const userRef = db().collection('users').doc(uid);
  const snap = await userRef.get();
  if (!snap.exists) {
    return res.status(404).json({ success: false, error: 'No user found with that uid' });
  }

  const log = snap.data().adminLog || [];
  log.push({ delta: 0, note: `Role changed to "${role}"`, resultingBalance: Number(snap.data().balance || 0), at: new Date().toISOString() });

  await userRef.set({ role, adminLog: log }, { merge: true });
  res.json({ success: true, uid, role });
}));

// POST /api/admin/adjust-balance  { uid, amount, direction: "add"|"deduct", note }
router.post('/adjust-balance', asyncHandler(async (req, res) => {
  const uid = String(req.body?.uid || '').trim();
  const amount = parseInt(req.body?.amount, 10);
  const direction = String(req.body?.direction || 'add');
  const note = String(req.body?.note || '').trim();

  if (!uid) return res.status(400).json({ success: false, error: 'Provide a uid' });
  if (!amount || amount <= 0) return res.status(400).json({ success: false, error: 'Enter a valid amount' });
  if (!['add', 'deduct'].includes(direction)) {
    return res.status(400).json({ success: false, error: 'direction must be "add" or "deduct"' });
  }

  const userRef = db().collection('users').doc(uid);
  try {
    let beforeBalance = 0;
    let userEmail = '';
    const newBalance = await db().runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      const current = snap.exists ? Number(snap.data().balance || 0) : 0;
      const delta = direction === 'add' ? amount : -amount;
      const updated = current + delta;
      if (updated < 0) throw new Error('That would take the balance negative');

      const log = snap.exists ? (snap.data().adminLog || []) : [];
      log.push({ delta, note, resultingBalance: updated, at: new Date().toISOString() });

      tx.set(userRef, { balance: updated, adminLog: log }, { merge: true });
      beforeBalance = current;
      userEmail = snap.exists ? (snap.data().email || '') : '';
      return updated;
    });
    res.json({ success: true, newBalance });

    // Telegram alert on the dedicated balance-load channel (after the
    // response, so a slow/failed Telegram call can never delay or fail
    // the actual balance change).
    notifyBalanceChange({
      actor: 'ADMIN', kind: direction === 'add' ? 'load' : 'deduct',
      uid, email: userEmail, amount, before: beforeBalance, after: newBalance, note,
    });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
}));

// POST /api/admin/set-status  { uid, requestStatus?, adminMessage? }
router.post('/set-status', asyncHandler(async (req, res) => {
  const uid = String(req.body?.uid || '').trim();
  if (!uid) return res.status(400).json({ success: false, error: 'Provide a uid' });

  const allowed = ['Active', 'Pending', 'Rejected', 'Banned'];
  const update = {};

  if (Object.prototype.hasOwnProperty.call(req.body, 'requestStatus')) {
    if (!allowed.includes(req.body.requestStatus)) {
      return res.status(400).json({ success: false, error: `requestStatus must be one of: ${allowed.join(', ')}` });
    }
    update.requestStatus = req.body.requestStatus;
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'adminMessage')) {
    update.adminMessage = String(req.body.adminMessage);
  }
  if (Object.keys(update).length === 0) {
    return res.status(400).json({ success: false, error: 'Nothing to update' });
  }

  await db().collection('users').doc(uid).set(update, { merge: true });
  res.json({ success: true });
}));

// POST /api/admin/topup-review  { uid, txCode, action: "approve"|"reject" }
router.post('/topup-review', asyncHandler(async (req, res) => {
  const uid = String(req.body?.uid || '').trim();
  const txCode = String(req.body?.txCode || '').trim().toUpperCase();
  const action = String(req.body?.action || '');

  if (!uid || !txCode) return res.status(400).json({ success: false, error: 'Provide uid and txCode' });
  if (!['approve', 'reject'].includes(action)) {
    return res.status(400).json({ success: false, error: 'action must be "approve" or "reject"' });
  }

  const userRef = db().collection('users').doc(uid);
  let approvedAmount = 0;
  try {
    const newBalance = await db().runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) throw new Error('User not found');
      const data = snap.data();
      const requests = data.topupRequests || [];

      let found = false;
      let amount = 0;
      const updatedRequests = requests.map((r) => {
        if (!found && r.txCode === txCode && r.status === 'PENDING') {
          found = true;
          amount = Number(r.amount || 0);
          approvedAmount = amount;
          return { ...r, status: action === 'approve' ? 'APPROVED' : 'REJECTED', reviewedAt: new Date().toISOString() };
        }
        return r;
      });

      if (!found) throw new Error('No matching PENDING request with that transaction code');

      const update = { topupRequests: updatedRequests };
      let balance = Number(data.balance || 0);

      if (action === 'approve') {
        balance += amount;
        const log = data.adminLog || [];
        log.push({
          delta: amount, note: `Top-up approved (txCode: ${txCode})`,
          resultingBalance: balance, at: new Date().toISOString(),
        });
        update.balance = balance;
        update.adminLog = log;
      }

      tx.set(userRef, update, { merge: true });
      return balance;
    });
    res.json({ success: true, newBalance });
    if (action === 'approve') {
      // Admin credited a customer's top-up: same dedicated channel as
      // every other staff balance load.
      notifyBalanceChange({
        actor: 'ADMIN', kind: 'load', title: 'TOP-UP APPROVED',
        uid, amount: approvedAmount, before: newBalance - approvedAmount, after: newBalance,
        note: `TX code: ${txCode}`,
      });
    } else {
      // Rejections aren't a balance load — left exactly as before.
      telegramNotify(telegramFormat('Balance Load Rejected', { username: uid, product: 'SRT X CHEATS (OWNER)', price: 0, uid, status: 'failed', others: `TX code: ${txCode}` }), 'balance');
    }
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
}));

// POST /api/admin/backfill-stats — one-time (safe to re-run) job that
// recomputes totalKeysBought/totalSpent for every user from their
// existing purchaseHistory array, for users who bought keys before
// the leaderboard feature started tracking these fields going forward.
router.post('/backfill-stats', asyncHandler(async (req, res) => {
  const snap = await db().collection('users').get();
  let updated = 0;
  const batchSize = 400;
  let batch = db().batch();
  let inBatch = 0;

  for (const doc of snap.docs) {
    const history = doc.data().purchaseHistory || [];
    const totalKeysBought = history.length;
    const totalSpent = history.reduce((sum, h) => sum + (Number(h.price) || 0), 0);
    batch.set(doc.ref, { totalKeysBought, totalSpent }, { merge: true });
    inBatch++;
    updated++;
    if (inBatch >= batchSize) {
      await batch.commit();
      batch = db().batch();
      inBatch = 0;
    }
  }
  if (inBatch > 0) await batch.commit();

  res.json({ success: true, usersUpdated: updated });
}));

// ---------------------------------------------------------------
// Products / maintenance — catalog1.js and catalog2.js describe the
// same physical products at two price tiers (retail vs reseller), so
// maintenance is tracked once per sku, not once per catalog, and
// applies to both automatically. The override lives in Firestore
// (productStatus/{sku}) so toggling it never needs a code deploy —
// see src/catalog.js for how it's merged into what the storefront sees.
// ---------------------------------------------------------------

// GET /api/admin/products — every sku (static + admin-added) with its
// current live maintenance/stock status, for the admin panel's product manager.
router.get('/products', asyncHandler(async (req, res) => {
  const [overrides, liveCatalog] = await Promise.all([getMaintenanceOverrides(), getLiveCatalog('user')]);
  const skus = Object.keys(liveCatalog).filter((sku) => liveCatalog[sku].type !== 'whatsapp'); // whatsapp products have their own list below

  // Two products sharing the same pid AND the same API-facing duration can't be
  // told apart by a reseller's API call — flag them so the admin can fix it.
  const labelCount = {};
  for (const sku of skus) {
    const k = `${String(liveCatalog[sku].pid ?? '').trim()}|${normDuration(apiLabel(liveCatalog[sku]))}`;
    labelCount[k] = (labelCount[k] || 0) + 1;
  }

  const products = skus.map((sku) => {
    const p = liveCatalog[sku];
    const pr = CATALOG_RESELLER[sku] || p;
    const o = overrides[sku];
    const maintenance = o ? !!o.maintenance : !!p.maintenance;
    const maintenanceMessage = maintenance
      ? (o?.maintenanceMessage || p.maintenanceMessage || 'This product is temporarily under maintenance.')
      : null;
    const outOfStock = !!p.outOfStock;
    const outOfStockMessage = outOfStock ? (p.outOfStockMessage || 'Out of stock — check back soon.') : null;
    return {
      sku, pid: p.pid, row: p.row, name: p.name, duration: p.duration, image: p.image,
      price: p.price, priceReseller: CATALOG[sku] ? pr.price : (p.priceReseller ?? p.price),
      tags: Array.isArray(p.tags) ? p.tags : [],
      apiDuration: p.apiDuration || '', apiLabel: apiLabel(p),
      apiConflict: labelCount[`${String(p.pid ?? '').trim()}|${normDuration(apiLabel(p))}`] > 1,
      maintenance, maintenanceMessage, outOfStock, outOfStockMessage,
      custom: !CATALOG[sku], // true for admin-added products, not in the static catalog files
    };
  });

  res.json({ success: true, products });
}));

// POST /api/admin/products/:sku/maintenance
// Body: { maintenance: boolean, message?: string }
//
// FIX: this used to gate on `CATALOG[sku]` (a static catalog1.js entry),
// which 404'd on every product now that catalog1.js/catalog2.js are
// empty and everything lives in Firestore's customProducts collection
// instead. Checking against the live catalog (static + custom +
// whatsapp merged) means maintenance mode works regardless of which
// collection a product's data actually lives in.
router.post('/products/:sku/maintenance', asyncHandler(async (req, res) => {
  const sku = String(req.params.sku || '').trim();
  const liveCatalog = await getLiveCatalog('user');
  if (!CATALOG[sku] && !liveCatalog[sku]) {
    return res.status(404).json({ success: false, error: 'Unknown sku' });
  }

  const maintenance = !!req.body?.maintenance;
  const message = String(req.body?.message || '').trim();
  if (message.length > 300) return res.status(400).json({ success: false, error: 'Keep the message under 300 characters' });

  await db().collection('productStatus').doc(sku).set({
    maintenance,
    maintenanceMessage: maintenance ? (message || 'This product is temporarily under maintenance.') : null,
    updatedAt: Date.now(),
  }, { merge: true });

  invalidateMaintenanceCache(); // so this takes effect immediately, not after the 30s cache TTL
  res.json({ success: true, sku, maintenance });
}));

// POST /api/admin/products/:sku/out-of-stock
// Body: { outOfStock: boolean, message?: string }
// Deliberately a separate field from maintenance: toggling this for one
// duration/sku (e.g. Pato's 3-day) never disables sibling skus (7-day,
// 15-day) that just happen to share the same product "row".
router.post('/products/:sku/out-of-stock', asyncHandler(async (req, res) => {
  const sku = String(req.params.sku || '').trim();
  if (!CATALOG[sku] && !(await findCustomProductFresh(sku))) {
    return res.status(404).json({ success: false, error: 'Unknown sku' });
  }

  const outOfStock = !!req.body?.outOfStock;
  const message = String(req.body?.message || '').trim();
  if (message.length > 300) return res.status(400).json({ success: false, error: 'Keep the message under 300 characters' });

  await db().collection('productStatus').doc(sku).set({
    outOfStock,
    outOfStockMessage: outOfStock ? (message || 'Out of stock — check back soon.') : null,
    updatedAt: Date.now(),
  }, { merge: true });

  invalidateMaintenanceCache();
  res.json({ success: true, sku, outOfStock });
}));

// Valid product tags. A product can carry more than one at once — e.g.
// a build that works on both rooted and non-rooted devices gets
// tags: ["ROOT","NONROOT"], and the storefront renders one badge per
// tag instead of squeezing it into a single derived category.
const VALID_TAGS = ['NONROOT', 'ROOT', 'IOS', 'PC'];

function normalizeTags(input) {
  const arr = Array.isArray(input) ? input : [];
  return [...new Set(arr.map((t) => String(t || '').trim().toUpperCase()))].filter((t) => VALID_TAGS.includes(t));
}

// POST /api/admin/products/create — add a brand new product line without
// a code deploy. One product ("row") can have several duration variants
// created together; each gets its own auto-generated sku but shares one
// admin-chosen pid AND one admin-chosen tag set (matches how one static
// product's durations all share a pid across catalog1.js/catalog2.js —
// tags now travel the same way).
// Body: {
//   image, pid: "122", row: "Pato team", tags: ["NONROOT","IOS"],
//   durations: [
//     { name: "Pato 3 day all color", duration: "3 Days All Colours Mix", price: 150, priceReseller: 120, apiDuration: "3 Days" /* optional */ },
//     ...
//   ]
// }
router.post('/products/create', asyncHandler(async (req, res) => {
  const image = String(req.body?.image || '').trim();
  const row = String(req.body?.row || '').trim();
  const pid = String(req.body?.pid || '').trim();
  const tags = normalizeTags(req.body?.tags);
  const durations = Array.isArray(req.body?.durations) ? req.body.durations : [];

  if (!image) return res.status(400).json({ success: false, error: 'Image link is required' });
  if (!row) return res.status(400).json({ success: false, error: 'Product full name is required' });
  if (!pid) return res.status(400).json({ success: false, error: 'Pid is required' });
  if (!tags.length) return res.status(400).json({ success: false, error: `Select at least one tag (${VALID_TAGS.join(', ')})` });
  if (!durations.length) return res.status(400).json({ success: false, error: 'Add at least one duration + price' });
  if (durations.length > 20) return res.status(400).json({ success: false, error: 'Too many durations in one go — split it up' });

  // Reseller API: pid + duration must identify exactly ONE product. Check the
  // labels of this batch against each other and against what already exists.
  const existingForPid = await loadPidProducts(pid);
  const seenLabels = new Set();
  for (let i = 0; i < durations.length; i++) {
    const d = durations[i];
    const apiDur = String(d?.apiDuration || '').trim();
    if (apiDur && !API_DURATION_RE.test(apiDur)) {
      return res.status(400).json({ success: false, error: `Duration #${i + 1}: API duration may only use letters, numbers, spaces and _ . + - (max 40 characters)` });
    }
    const label = apiDur || String(d?.duration || '').trim();
    const norm = normDuration(label);
    if (norm && seenLabels.has(norm)) {
      return res.status(400).json({ success: false, error: `Duration #${i + 1}: "${label}" is the same API duration as another row in this product — each duration needs a different one` });
    }
    seenLabels.add(norm);
    const clash = findLabelConflict(existingForPid, pid, label);
    if (clash) {
      return res.status(400).json({ success: false, error: `Duration #${i + 1}: pid ${pid} already has "${apiLabel(clash)}" (${clash.name}). The reseller API couldn't tell them apart — set a different API duration.` });
    }
  }

  const batch = db().batch();
  const created = [];

  for (let i = 0; i < durations.length; i++) {
    const d = durations[i];
    const name = String(d?.name || '').trim();
    const duration = String(d?.duration || '').trim();
    const apiDuration = String(d?.apiDuration || '').trim();
    const price = Number(d?.price);
    const priceReseller = d?.priceReseller !== undefined && d?.priceReseller !== '' ? Number(d.priceReseller) : price;
    if (!name || !duration) return res.status(400).json({ success: false, error: `Duration #${i + 1}: name and duration label are required` });
    if (!price || price <= 0) return res.status(400).json({ success: false, error: `Duration #${i + 1}: user price must be a positive number` });
    if (!priceReseller || priceReseller <= 0) return res.status(400).json({ success: false, error: `Duration #${i + 1}: reseller price must be a positive number` });

    const sku = `custom_${pid}_${i + 1}_${Date.now().toString(36)}`;
    const product = { pid, row, name, duration, price, priceReseller, image, tags, createdAt: Date.now(), ...(apiDuration ? { apiDuration } : {}) };
    batch.set(db().collection('customProducts').doc(sku), product);
    created.push({ sku, ...product });
  }

  await batch.commit();
  invalidateCustomProductCache();
  res.json({ success: true, row, products: created });
}));

// POST /api/admin/products/:sku/edit
// Body: any of { image, name, duration, price, priceReseller, pid } — only
// the fields provided are changed. Works on custom products (updates their
// own doc directly) AND static catalog1.js/catalog2.js products (stored as
// an override in productStatus/{sku}, same doc maintenance/stock already use).
router.post('/products/:sku/edit', asyncHandler(async (req, res) => {
  const sku = String(req.params.sku || '').trim();
  const fields = {};
  for (const key of ['image', 'name', 'duration', 'pid']) {
    if (req.body?.[key] !== undefined) {
      const v = String(req.body[key]).trim();
      if (!v) return res.status(400).json({ success: false, error: `${key} can't be empty` });
      fields[key] = v;
    }
  }
  if (req.body?.price !== undefined) {
    const v = Number(req.body.price);
    if (!v || v <= 0) return res.status(400).json({ success: false, error: 'User price must be a positive number' });
    fields.price = v;
  }
  if (req.body?.priceReseller !== undefined) {
    const v = Number(req.body.priceReseller);
    if (!v || v <= 0) return res.status(400).json({ success: false, error: 'Reseller price must be a positive number' });
    fields.priceReseller = v;
  }
  if (req.body?.tags !== undefined) {
    const v = normalizeTags(req.body.tags);
    if (!v.length) return res.status(400).json({ success: false, error: `Select at least one tag (${VALID_TAGS.join(', ')})` });
    fields.tags = v;
  }
  // apiDuration is the one field that MAY be blank: blank = "use the normal
  // duration label for the API".
  if (req.body?.apiDuration !== undefined) {
    const v = String(req.body.apiDuration).trim();
    if (v && !API_DURATION_RE.test(v)) return res.status(400).json({ success: false, error: 'API duration may only use letters, numbers, spaces and _ . + - (max 40 characters)' });
    fields.apiDuration = v;
  }
  if (!Object.keys(fields).length) return res.status(400).json({ success: false, error: 'Nothing to update' });

  const custom = await getCustomProductRaw(sku);

  // Only when pid / duration / apiDuration actually change: make sure the result
  // still identifies exactly one product for the reseller API. (A price-only
  // edit never trips this, even on a product that already had a clash.)
  if (custom && ['pid', 'duration', 'apiDuration'].some((k) => fields[k] !== undefined && fields[k] !== (custom[k] ?? ''))) {
    const merged = { ...custom, ...fields };
    const clash = findLabelConflict(await loadPidProducts(merged.pid), merged.pid, apiLabel(merged), sku);
    if (clash) {
      return res.status(400).json({ success: false, error: `pid ${merged.pid} already has "${apiLabel(clash)}" (${clash.name}). The reseller API couldn't tell them apart — use a different API duration.` });
    }
  }

  if (custom) {
    await db().collection('customProducts').doc(sku).set(fields, { merge: true });
    invalidateCustomProductCache();
  } else if (CATALOG[sku]) {
    await db().collection('productStatus').doc(sku).set({ ...fields, updatedAt: Date.now() }, { merge: true });
    invalidateMaintenanceCache();
  } else {
    return res.status(404).json({ success: false, error: 'Unknown sku' });
  }
  res.json({ success: true, sku, updated: fields });
}));

// POST /api/admin/products/:sku/delete — custom products only. A static
// (catalog1.js/catalog2.js) product can't be truly deleted without a code
// change; use maintenance mode to take it down instead.
router.post('/products/:sku/delete', asyncHandler(async (req, res) => {
  const sku = String(req.params.sku || '').trim();
  if (CATALOG[sku]) {
    return res.status(400).json({ success: false, error: "That's a built-in product — use Maintenance to disable it instead of deleting" });
  }
  const custom = await getCustomProductRaw(sku);
  if (!custom) return res.status(404).json({ success: false, error: 'Unknown sku' });

  await deleteCustomProduct(sku);
  await db().collection('productStatus').doc(sku).delete().catch(() => {}); // clean up any maintenance/stock override too, if one existed
  invalidateMaintenanceCache();
  res.json({ success: true, sku });
}));

// ---------------------------------------------------------------
// WhatsApp-redirect products — no duration, no automated checkout, no
// key delivery. The card's "buy" action is a WhatsApp deep link with a
// pre-filled message instead. See src/catalog.js for why these are kept
// out of catalogFind() entirely.
// ---------------------------------------------------------------

// GET /api/admin/products/whatsapp
router.get('/products/whatsapp', asyncHandler(async (req, res) => {
  const snap = await db().collection('whatsappProducts').get();
  const products = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  res.json({ success: true, products });
}));

// POST /api/admin/products/create-whatsapp
// Body: { image, name, price, priceReseller, whatsappNumber, whatsappMessage, viewDetails }
router.post('/products/create-whatsapp', asyncHandler(async (req, res) => {
  const image = String(req.body?.image || '').trim();
  const name = String(req.body?.name || '').trim();
  const price = Number(req.body?.price);
  const priceReseller = req.body?.priceReseller !== undefined && req.body?.priceReseller !== '' ? Number(req.body.priceReseller) : price;
  const whatsappNumber = String(req.body?.whatsappNumber || '').replace(/[^\d]/g, '');
  const whatsappMessage = String(req.body?.whatsappMessage || '').trim().slice(0, 400);
  const viewDetails = String(req.body?.viewDetails || '').trim().slice(0, 1000);

  if (!image) return res.status(400).json({ success: false, error: 'Image link is required' });
  if (!name) return res.status(400).json({ success: false, error: 'Product name is required' });
  if (!price || price <= 0) return res.status(400).json({ success: false, error: 'User price must be a positive number' });
  if (!priceReseller || priceReseller <= 0) return res.status(400).json({ success: false, error: 'Reseller price must be a positive number' });
  if (!whatsappNumber) return res.status(400).json({ success: false, error: 'WhatsApp number is required (digits only, with country code)' });

  const id = `wa_${Date.now().toString(36)}`;
  const product = { image, name, price, priceReseller, whatsappNumber, whatsappMessage, viewDetails, createdAt: Date.now() };
  await db().collection('whatsappProducts').doc(id).set(product);
  invalidateWhatsappProductCache();
  res.json({ success: true, id, ...product });
}));

// POST /api/admin/products/whatsapp/:id/edit
router.post('/products/whatsapp/:id/edit', asyncHandler(async (req, res) => {
  const id = String(req.params.id || '').trim();
  const existing = await getWhatsappProductRaw(id);
  if (!existing) return res.status(404).json({ success: false, error: 'Unknown product' });

  const fields = {};
  for (const key of ['image', 'name', 'whatsappMessage', 'viewDetails']) {
    if (req.body?.[key] !== undefined) fields[key] = String(req.body[key]).trim();
  }
  if (req.body?.whatsappNumber !== undefined) {
    const v = String(req.body.whatsappNumber).replace(/[^\d]/g, '');
    if (!v) return res.status(400).json({ success: false, error: 'WhatsApp number is required' });
    fields.whatsappNumber = v;
  }
  if (req.body?.price !== undefined) {
    const v = Number(req.body.price);
    if (!v || v <= 0) return res.status(400).json({ success: false, error: 'User price must be a positive number' });
    fields.price = v;
  }
  if (req.body?.priceReseller !== undefined) {
    const v = Number(req.body.priceReseller);
    if (!v || v <= 0) return res.status(400).json({ success: false, error: 'Reseller price must be a positive number' });
    fields.priceReseller = v;
  }
  if (!Object.keys(fields).length) return res.status(400).json({ success: false, error: 'Nothing to update' });

  await db().collection('whatsappProducts').doc(id).set(fields, { merge: true });
  invalidateWhatsappProductCache();
  res.json({ success: true, id, updated: fields });
}));

// POST /api/admin/products/whatsapp/:id/delete
router.post('/products/whatsapp/:id/delete', asyncHandler(async (req, res) => {
  const id = String(req.params.id || '').trim();
  const existing = await getWhatsappProductRaw(id);
  if (!existing) return res.status(404).json({ success: false, error: 'Unknown product' });
  await deleteWhatsappProduct(id);
  res.json({ success: true, id });
}));

// ---------------------------------------------------------------
// Redeem codes — admin creates gift/promo codes worth a fixed Rs
// amount, optionally capped by an expiry date and/or a max number
// of redemptions. Stored in the `redeemCodes` collection, doc ID =
// the code itself. Redemption itself happens via POST /api/user/redeem.
// ---------------------------------------------------------------

function generateRedeemCode() {
  // SRT_XXXXX_YYYYYCHEATS — two 5-char groups, no 0/O/1/I to avoid confusion
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const group = (n) => Array.from({ length: n }, () => chars[crypto.randomInt(chars.length)]).join('');
  return `SRT_${group(5)}_${group(5)}CHEATS`;
}

// Shared by POST /redeem-codes and the announcement gift flow below, so a
// gift attached to a broadcast is a completely normal redeem code — same
// validation, same collection, same redemption path.
async function createRedeemCodeDoc({ amount, maxUses, expiresAt, code }) {
  amount = Number(amount);
  if (!amount || amount <= 0) throw Object.assign(new Error('Amount must be a positive number'), { status: 400 });

  if (maxUses === '' || maxUses === undefined || maxUses === null || String(maxUses).toLowerCase() === 'unlimited') {
    maxUses = null;
  } else {
    maxUses = Number(maxUses);
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100) {
      throw Object.assign(new Error('Max uses must be a whole number between 1 and 100, or unlimited'), { status: 400 });
    }
  }

  let expiresAtMs = null;
  if (expiresAt && String(expiresAt).toLowerCase() !== 'unlimited') {
    const t = new Date(expiresAt).getTime();
    if (Number.isNaN(t)) throw Object.assign(new Error('Invalid expiry date'), { status: 400 });
    expiresAtMs = t;
  }

  const finalCode = String(code || '').trim().toUpperCase() || generateRedeemCode();
  const ref = db().collection('redeemCodes').doc(finalCode);
  const existing = await ref.get();
  if (existing.exists) throw Object.assign(new Error('That code already exists'), { status: 409 });

  const docData = {
    code: finalCode, amount, maxUses, expiresAt: expiresAtMs,
    active: true, usedCount: 0, redeemedBy: [],
    createdAt: Date.now(),
  };
  await ref.set(docData);
  return docData;
}

// POST /api/admin/redeem-codes
// Body: { amount, maxUses (1-100, or null/omit for unlimited), expiresAt (ISO date string, or null/omit for unlimited), code (optional custom code) }
router.post('/redeem-codes', asyncHandler(async (req, res) => {
  try {
    const result = await createRedeemCodeDoc(req.body || {});
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(e.status || 400).json({ success: false, error: e.message });
  }
}));

// GET /api/admin/redeem-codes — list all codes, newest first
router.get('/redeem-codes', asyncHandler(async (req, res) => {
  const snap = await db().collection('redeemCodes').orderBy('createdAt', 'desc').limit(200).get();
  const codes = snap.docs.map((d) => d.data());
  res.json({ success: true, codes });
}));

// POST /api/admin/redeem-codes/:code/deactivate — stop a code from being used again
router.post('/redeem-codes/:code/deactivate', asyncHandler(async (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  const ref = db().collection('redeemCodes').doc(code);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ success: false, error: 'Code not found' });
  await ref.set({ active: false }, { merge: true });
  res.json({ success: true });
}));

// ---------------------------------------------------------------
// Stats + rankings — both read only the fields purchase.js actually
// keeps up to date (balance, totalSpent, totalKeysBought via
// FieldValue.increment), not the older per-order `history` array the
// admin panel used to scan directly. 185 users is nothing for a plain
// full-collection read, same approach /backfill-stats already uses.
// ---------------------------------------------------------------

// GET /api/admin/stats — headline numbers for the dashboard cards
router.get('/stats', asyncHandler(async (req, res) => {
  const snap = await db().collection('users').get();
  let totalRevenue = 0, totalKeysSold = 0;
  snap.forEach((d) => {
    const data = d.data();
    totalRevenue += Number(data.totalSpent || 0);
    totalKeysSold += Number(data.totalKeysBought || 0);
  });
  res.json({ success: true, totalUsers: snap.size, totalRevenue, totalKeysSold });
}));

// GET /api/admin/rankings — top users by spend
router.get('/rankings', asyncHandler(async (req, res) => {
  const snap = await db().collection('users').orderBy('totalSpent', 'desc').limit(100).get();
  const rankings = snap.docs.map((d) => {
    const data = d.data();
    return {
      uid: d.id,
      email: data.email || '',
      profileName: data.profileName || '',
      role: data.role || 'user',
      balance: Number(data.balance || 0),
      totalSpent: Number(data.totalSpent || 0),
      totalKeysBought: Number(data.totalKeysBought || 0),
    };
  });
  res.json({ success: true, rankings });
}));

// ---------------------------------------------------------------
// Announcements — a broadcast message shown to every user as a popup
// on their next login, optionally bundled with a gift redeem code.
// "Seen" is tracked per-user (users/{uid}.lastSeenAnnouncementId), not
// as a growing array on the announcement doc, so this stays cheap
// regardless of user count. See GET/POST /api/user/announcement*.
// ---------------------------------------------------------------

// POST /api/admin/announcements
// Body: { message, giftAmount?, giftMaxUses?, giftExpiresAt? }
// If giftAmount is provided, a normal redeem code is created (default
// unlimited uses, since it's meant for every user) and attached.
router.post('/announcements', asyncHandler(async (req, res) => {
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ success: false, error: 'Write a message first' });
  if (message.length > 500) return res.status(400).json({ success: false, error: 'Keep the message under 500 characters' });

  let gift = null;
  const giftAmount = req.body?.giftAmount;
  if (giftAmount !== undefined && giftAmount !== null && giftAmount !== '') {
    try {
      gift = await createRedeemCodeDoc({
        amount: giftAmount,
        maxUses: req.body?.giftMaxUses ?? null,
        expiresAt: req.body?.giftExpiresAt ?? null,
      });
    } catch (e) {
      return res.status(e.status || 400).json({ success: false, error: `Gift code: ${e.message}` });
    }
  }

  const id = `ann_${Date.now()}`;
  const docData = {
    id, message,
    giftCode: gift?.code || null,
    giftAmount: gift?.amount || null,
    active: true,
    createdAt: Date.now(),
  };

  // Deactivate any previously-active announcements first, so there's
  // only ever one live at a time (also keeps the /announcement read
  // above cheap — it only ever has to scan a handful of docs).
  const prevActive = await db().collection('announcements').where('active', '==', true).limit(20).get();
  if (!prevActive.empty) {
    const batch = db().batch();
    prevActive.docs.forEach((d) => batch.set(d.ref, { active: false }, { merge: true }));
    await batch.commit();
  }

  await db().collection('announcements').doc(id).set(docData);
  res.json({ success: true, announcement: docData });
}));

// GET /api/admin/announcements — list, newest first
router.get('/announcements', asyncHandler(async (req, res) => {
  const snap = await db().collection('announcements').orderBy('createdAt', 'desc').limit(50).get();
  res.json({ success: true, announcements: snap.docs.map((d) => d.data()) });
}));

// POST /api/admin/announcements/:id/deactivate
router.post('/announcements/:id/deactivate', asyncHandler(async (req, res) => {
  const id = String(req.params.id || '').trim();
  const ref = db().collection('announcements').doc(id);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ success: false, error: 'Announcement not found' });
  await ref.set({ active: false }, { merge: true });
  res.json({ success: true });
}));

// ---------------------------------------------------------------
// GET /api/admin/users — full user directory for the admin panel.
//
// Query params (all optional):
//   topupDays=7 | 30    only users whose most recent APPROVED topup
//                       falls within the last N days
//   q=<text>           case-insensitive match on name/email/phone/uid
//   limit=<n>           default 200, max 500
//
// Returns exactly the fields the panel's user-list table needs — name,
// whatsapp, email, balance, keys bought, total spent, last topup date,
// role — computed from real fields already on each user doc (no new
// fields invented, nothing stored twice).
// ---------------------------------------------------------------
router.get('/users', asyncHandler(async (req, res) => {
  const topupDays = req.query.topupDays ? parseInt(req.query.topupDays, 10) : null;
  const q = String(req.query.q || '').trim().toLowerCase();
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));

  const cutoff = topupDays ? Date.now() - topupDays * 24 * 60 * 60 * 1000 : null;

  const snap = await db().collection('users').get();
  const rows = [];

  snap.forEach((doc) => {
    const d = doc.data();
    const topups = Array.isArray(d.topupRequests) ? d.topupRequests : [];

    // "Last topup" means the most recent APPROVED one — a pending or
    // rejected request never added real balance, so it shouldn't count
    // as the user's last successful top-up.
    const approved = topups.filter((t) => t.status === 'APPROVED');
    const lastTopup = approved.length
      ? approved.reduce((latest, t) => (new Date(t.date) > new Date(latest.date) ? t : latest))
      : null;
    const lastTopupAt = lastTopup ? new Date(lastTopup.date).getTime() : null;

    if (cutoff !== null && (!lastTopupAt || lastTopupAt < cutoff)) return; // outside the window -> skip

    const row = {
      uid: doc.id,
      name: d.profileName || (d.email ? d.email.split('@')[0] : 'Unknown'),
      whatsapp: d.profilePhone || '',
      email: d.email || '',
      balance: Number(d.balance || 0),
      totalKeysBought: Number(d.totalKeysBought || 0),
      totalSpent: Number(d.totalSpent || 0),
      lastTopupAt,
      lastTopupAmount: lastTopup ? Number(lastTopup.amount || 0) : null,
      role: d.role || 'user',
    };

    if (q) {
      const hay = `${row.name} ${row.email} ${row.whatsapp} ${row.uid}`.toLowerCase();
      if (!hay.includes(q)) return;
    }

    rows.push(row);
  });

  // Most recent top-up first when filtering by topup window (that's the
  // point of the view); otherwise highest lifetime spend first, so the
  // full directory opens with your best customers on top.
  rows.sort((a, b) => (topupDays ? (b.lastTopupAt || 0) - (a.lastTopupAt || 0) : b.totalSpent - a.totalSpent));

  res.json({ success: true, total: rows.length, users: rows.slice(0, limit) });
}));

// ---------------------------------------------------------------
// POLICY — the admin-only write side of the public GET /api/policy
// (defined in server.js, not here, since it has to be reachable
// without an admin secret). Stored as a single Firestore doc
// (config/policy), which is the one and only place this text lives —
// there is no way to edit it except through this endpoint, so a
// devtools edit to what a page displays never persists past that one
// page load.
// ---------------------------------------------------------------
router.get('/policy', asyncHandler(async (req, res) => {
  const snap = await db().collection('config').doc('policy').get();
  const data = snap.exists ? snap.data() : {};
  res.json({ success: true, title: data.title || '', body: data.body || '', updatedAt: data.updatedAt || null });
}));

router.post('/policy', asyncHandler(async (req, res) => {
  const title = String(req.body?.title || '').trim();
  const body = String(req.body?.body || '').trim();
  if (!title) return res.status(400).json({ success: false, error: 'Title is required' });
  if (!body) return res.status(400).json({ success: false, error: 'Policy text is required' });
  if (body.length > 20000) return res.status(400).json({ success: false, error: 'Policy text is too long (max 20,000 characters)' });

  await db().collection('config').doc('policy').set({ title, body, updatedAt: Date.now() }, { merge: true });
  res.json({ success: true });
}));

// ---------------------------------------------------------------
// RESELLER API management — see routes/reseller-api.js for the API itself.
//   * One global ON/OFF switch (emergency brake for the whole API)
//   * Per-reseller: list, disable/enable, revoke
//   * Per-reseller order log (every key the API handed out)
// Admins never see anyone's keys — only hashes are stored.
// ---------------------------------------------------------------

router.get('/api-settings', asyncHandler(async (req, res) => {
  const s = await getApiSettings();
  res.json({ success: true, enabled: s.enabled, updatedAt: s.updatedAt });
}));

router.post('/api-settings', asyncHandler(async (req, res) => {
  if (typeof req.body?.enabled !== 'boolean') {
    return res.status(400).json({ success: false, error: 'enabled must be true or false' });
  }
  await setApiEnabled(req.body.enabled);
  telegramNotify(`${req.body.enabled ? '🟢' : '🔴'} <b>RESELLER API turned ${req.body.enabled ? 'ON' : 'OFF'}</b> (admin panel)`, 'reseller');
  res.json({ success: true, enabled: req.body.enabled });
}));

// GET /api/admin/api-clients — every reseller that has generated API keys.
router.get('/api-clients', asyncHandler(async (req, res) => {
  const snap = await db().collection('apiClients').limit(300).get();
  if (snap.empty) return res.json({ success: true, clients: [] });

  const userSnaps = await db().getAll(...snap.docs.map((d) => db().collection('users').doc(d.id)));
  const userById = {};
  userSnaps.forEach((u) => { if (u.exists) userById[u.id] = u.data(); });

  const clients = snap.docs.map((d) => {
    const c = d.data();
    const u = userById[d.id] || {};
    return {
      uid: d.id, email: u.email || c.email || '', name: u.profileName || '',
      role: u.role || 'user', balance: Number(u.balance || 0),
      totalKeysBought: Number(u.totalKeysBought || 0),
      prefix: c.prefix || '', createdAt: c.createdAt || null,
      regeneratedAt: c.regeneratedAt || null, lastUsedAt: c.lastUsedAt || null,
      disabled: !!c.disabled,
    };
  }).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  res.json({ success: true, clients });
}));

// POST /api/admin/api-clients/:uid/disable  { disabled: boolean }
router.post('/api-clients/:uid/disable', asyncHandler(async (req, res) => {
  const uid = String(req.params.uid || '').trim();
  if (typeof req.body?.disabled !== 'boolean') {
    return res.status(400).json({ success: false, error: 'disabled must be true or false' });
  }
  const ref = db().collection('apiClients').doc(uid);
  if (!(await ref.get()).exists) return res.status(404).json({ success: false, error: 'That user has no API keys' });
  await ref.update({ disabled: req.body.disabled, disabledAt: req.body.disabled ? Date.now() : null });
  res.json({ success: true, uid, disabled: req.body.disabled });
}));

// POST /api/admin/api-clients/:uid/revoke — deletes their keys outright. The
// reseller can generate a fresh pair (unlike "disable", which blocks that too).
router.post('/api-clients/:uid/revoke', asyncHandler(async (req, res) => {
  const uid = String(req.params.uid || '').trim();
  const ref = db().collection('apiClients').doc(uid);
  if (!(await ref.get()).exists) return res.status(404).json({ success: false, error: 'That user has no API keys' });
  await ref.delete();
  res.json({ success: true, uid });
}));

// GET /api/admin/api-orders?uid=...&limit=30 — a reseller's recent API orders.
router.get('/api-orders', asyncHandler(async (req, res) => {
  const uid = String(req.query.uid || '').trim();
  if (!uid) return res.status(400).json({ success: false, error: 'Provide a uid' });
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 30));
  const snap = await db().collection('users').doc(uid).collection('apiOrders').orderBy('createdAt', 'desc').limit(limit).get();
  res.json({
    success: true,
    orders: snap.docs.map((d) => {
      const o = d.data();
      return {
        orderId: o.orderId, status: o.status, product: o.productRow, pid: o.pid, duration: o.durationLabel,
        quantity: o.quantity, delivered: o.delivered || 0, charged: o.charged || 0, refunded: o.refunded || 0,
        keys: o.keys || [], createdAt: o.createdAt, finishedAt: o.finishedAt || null, error: o.error || null,
      };
    }),
  });
}));

export default router;
