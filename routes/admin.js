import express from 'express';
import crypto from 'crypto';
import { asyncHandler } from '../src/asyncHandler.js';
import { db, requireAdmin, adminCors } from '../src/firebase.js';
import { rateLimit } from '../src/security.js';
import { getMaintenanceOverrides, invalidateMaintenanceCache, getLiveCatalog, invalidateProductCache, findProductFresh, getProductRaw, deleteCustomProduct, upsertProduct, invalidateWhatsappProductCache, getWhatsappProductRaw, deleteWhatsappProduct } from '../src/catalog.js';
import { telegramNotify, telegramFormat } from '../src/telegram.js';

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
    let approvedAmount = 0;
    const newBalance = await db().runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      const current = snap.exists ? Number(snap.data().balance || 0) : 0;
      const delta = direction === 'add' ? amount : -amount;
      const updated = current + delta;
      if (updated < 0) throw new Error('That would take the balance negative');

      const log = snap.exists ? (snap.data().adminLog || []) : [];
      log.push({ delta, note, resultingBalance: updated, at: new Date().toISOString() });

      tx.set(userRef, { balance: updated, adminLog: log }, { merge: true });
      return updated;
    });
    res.json({ success: true, newBalance });
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
    telegramNotify(telegramFormat(`Balance Load ${action === 'approve' ? 'Approved' : 'Rejected'}`, { username: uid, product: 'SRT X CHEATS (OWNER)', price: action === 'approve' ? approvedAmount : 0, uid, status: action === 'approve' ? 'success' : 'failed', others: `TX code: ${txCode}` }), 'balance');
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
// ---------------------------------------------------------------
// Firestore-only products / maintenance.
// Every product is stored in products/{sku}; catalog1.js/catalog2.js
// are intentionally empty. One Firestore document represents one
// purchasable duration/SKU and can carry multiple tags.
// ---------------------------------------------------------------

const cleanTags = (tags) => {
  const allowed = new Set(['IOS','NONROOT','ROOT','PC','FREE']);
  const raw = Array.isArray(tags) ? tags : String(tags || '').split(',');
  return [...new Set(raw.map(x => String(x).trim().toUpperCase())
    .filter(x => allowed.has(x))
    .map(x => x === 'IOS' ? 'iOS' : x))];
};

router.get('/products', asyncHandler(async (req, res) => {
  const liveCatalog = await getLiveCatalog('user');
  const products = Object.entries(liveCatalog)
    .filter(([,p]) => p.type !== 'whatsapp')
    .map(([sku,p]) => ({
      sku, pid:p.pid || '', row:p.row || p.name || '', name:p.name || '',
      duration:p.duration || '', image:p.image || '',
      price:Number(p.price || 0), priceReseller:Number(p.priceReseller ?? p.price ?? 0),
      tags:cleanTags(p.tags), source:p.source || 'reseller',
      free:!!p.free, maintenance:!!p.maintenance,
      maintenanceMessage:p.maintenanceMessage || null,
      outOfStock:!!p.outOfStock, outOfStockMessage:p.outOfStockMessage || null,
      rating:p.rating ?? null, reviewCount:p.reviewCount || 0,
    }));
  res.json({ success:true, products });
}));

router.post('/products/:sku/maintenance', asyncHandler(async (req,res) => {
  const sku=String(req.params.sku||'').trim();
  const existing=await getProductRaw(sku);
  if(!existing) return res.status(404).json({success:false,error:'Unknown sku'});
  const maintenance=!!req.body?.maintenance;
  const message=String(req.body?.message||'').trim().slice(0,300);
  await db().collection('productStatus').doc(sku).set({
    maintenance,
    maintenanceMessage:maintenance ? (message || 'This product is temporarily under maintenance.') : null,
    updatedAt:Date.now(),
  },{merge:true});
  invalidateMaintenanceCache();
  res.json({success:true,sku,maintenance});
}));

router.post('/products/:sku/out-of-stock', asyncHandler(async (req,res) => {
  const sku=String(req.params.sku||'').trim();
  if(!(await getProductRaw(sku))) return res.status(404).json({success:false,error:'Unknown sku'});
  const outOfStock=!!req.body?.outOfStock;
  const message=String(req.body?.message||'').trim().slice(0,300);
  await db().collection('productStatus').doc(sku).set({
    outOfStock,
    outOfStockMessage:outOfStock ? (message || 'Out of stock — check back soon.') : null,
    updatedAt:Date.now(),
  },{merge:true});
  invalidateMaintenanceCache();
  res.json({success:true,sku,outOfStock});
}));

// POST /api/admin/products/create
// Body: {image,row,pid,tags:[],durations:[{name,duration,price,priceReseller,source,free}]}
router.post('/products/create', asyncHandler(async (req,res) => {
  const image=String(req.body?.image||'').trim();
  const row=String(req.body?.row||'').trim();
  const pid=String(req.body?.pid||'').trim();
  const tags=cleanTags(req.body?.tags);
  const durations=Array.isArray(req.body?.durations)?req.body.durations:[];
  const defaultSource=String(req.body?.source||'reseller').trim()==='fps'?'fps':'reseller';
  if(!image) return res.status(400).json({success:false,error:'Image link is required'});
  if(!row) return res.status(400).json({success:false,error:'Product name is required'});
  if(!pid) return res.status(400).json({success:false,error:'PID is required'});
  if(!durations.length || durations.length>20) return res.status(400).json({success:false,error:'Add 1-20 durations'});
  const batch=db().batch(), created=[];
  for(let i=0;i<durations.length;i++){
    const d=durations[i];
    const name=String(d?.name||row).trim();
    const duration=String(d?.duration||'').trim();
    const price=Number(d?.price);
    const priceReseller=Number(d?.priceReseller ?? price);
    if(!name || !duration || !(price>0) || !(priceReseller>0))
      return res.status(400).json({success:false,error:`Duration #${i+1}: name, duration and valid prices are required`});
    const sku=String(d?.sku||`p_${pid}_${Date.now().toString(36)}_${i+1}`).replace(/[^A-Za-z0-9_-]/g,'_').slice(0,120);
    const ref=db().collection('products').doc(sku);
    const product={
      row,name,duration,pid,image,price,priceReseller,tags,
      source:String(d?.source||defaultSource),
      free:!!d?.free || tags.includes('FREE'),
      createdAt:Date.now(),updatedAt:Date.now()
    };
    batch.set(ref,product,{merge:true}); created.push({sku,...product});
  }
  await batch.commit(); invalidateProductCache();
  res.json({success:true,row,products:created});
}));

router.post('/products/:sku/edit', asyncHandler(async(req,res)=>{
  const sku=String(req.params.sku||'').trim();
  const existing=await getProductRaw(sku);
  if(!existing) return res.status(404).json({success:false,error:'Unknown sku'});
  const fields={};
  for(const key of ['image','name','duration','pid','row','source']){
    if(req.body?.[key]!==undefined){
      const v=String(req.body[key]).trim();
      if(!v) return res.status(400).json({success:false,error:`${key} can't be empty`});
      fields[key]=v;
    }
  }
  if(req.body?.tags!==undefined) fields.tags=cleanTags(req.body.tags);
  if(req.body?.price!==undefined){
    const v=Number(req.body.price); if(!(v>0)) return res.status(400).json({success:false,error:'User price must be positive'});
    fields.price=v;
  }
  if(req.body?.priceReseller!==undefined){
    const v=Number(req.body.priceReseller); if(!(v>0)) return res.status(400).json({success:false,error:'Reseller price must be positive'});
    fields.priceReseller=v;
  }
  if(req.body?.free!==undefined) fields.free=!!req.body.free;
  if(!Object.keys(fields).length) return res.status(400).json({success:false,error:'Nothing to update'});
  fields.updatedAt=Date.now();
  await db().collection('products').doc(sku).set(fields,{merge:true});
  invalidateProductCache();
  res.json({success:true,sku,updated:fields});
}));

router.post('/products/:sku/delete', asyncHandler(async(req,res)=>{
  const sku=String(req.params.sku||'').trim();
  if(!(await getProductRaw(sku))) return res.status(404).json({success:false,error:'Unknown sku'});
  await db().collection('products').doc(sku).delete();
  await db().collection('productStatus').doc(sku).delete().catch(()=>{});
  invalidateProductCache(); invalidateMaintenanceCache();
  res.json({success:true,sku});
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

export default router;
