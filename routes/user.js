// src by SRT X CHEATS. Copy right SRT X CHEATS
import express from 'express';
import admin from 'firebase-admin';
import { asyncHandler } from '../src/asyncHandler.js';
import { db, requireFirebaseUid, userCors } from '../src/firebase.js';
// src by SRT X CHEATS. Copy right SRT X CHEATS
import { telegramNotify, telegramFormat, esc } from '../src/telegram.js';
import { getLiveCatalog, getFeedbackList, recordFeedback } from '../src/srt_storage_product.js';
import { leaderboardCache, announcementCache } from '../src/sharedCaches.js';
import { uploadAvatar } from '../src/imgbb.js';
import { getVersions } from '../src/versions.js';
// src by SRT X CHEATS. Copy right SRT X CHEATS
import {
  LIMITS_MS, computeLocks, assertUnlocked, RuleError,
  normalizePanelLink, normalizeTikTokUser, normalizeTikTokName,
} from '../src/profileRules.js';
import { getUserDoc, invalidateUserDoc } from '../src/userCache.js';
// src by SRT X CHEATS. Copy right SRT X CHEATS
import { isBotUid, botDocId, getBot } from '../src/leaderboardBots.js';
import { botCosmetics, cosmeticsFor, NO_COSMETICS } from '../src/rewards.js';
import { rateLimit } from '../src/security.js';
import { isResellerTier, proPublicState, PRO_MIN_TOPUP } from '../src/proTier.js';
import { sendProRequestToBot } from '../src/proReseller.js';
// src by SRT X CHEATS. Copy right SRT X CHEATS
import { newReqId as newProReqId } from '../src/topupQr.js';
import {
  QR_MIN_AMOUNT, QR_MAX_AMOUNT, QR_MAX_PENDING, QR_PENDING_WINDOW_MS, QR_METHOD, newReqId, sendRequestToBot,
} from '../src/topupQr.js';

// src by SRT X CHEATS. Copy right SRT X CHEATS
const router = express.Router();
router.use(userCors);
router.use(requireFirebaseUid);

const DEFAULTS = (email) => ({
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  email,
  role: 'user',
  profileName: '',
  profilePhone: '',
  tiktokName: '',
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  tiktokUser: '',
  panelLink: '',
  avatarUrl: '',
  requestStatus: 'Active',
  adminMessage: 'Welcome! Pay via eSewa or Balance to get your key 🔑',
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  balance: 0,
  purchaseHistory: [],
  totalKeysBought: 0,
  totalSpent: 0,
});
// src by SRT X CHEATS. Copy right SRT X CHEATS

router.post('/init', asyncHandler(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const phone = String(req.body?.phone || '').trim();
  let tiktokName = '', tiktokUser = '';
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  try {
    tiktokName = normalizeTikTokName(req.body?.tiktokName);
    tiktokUser = normalizeTikTokUser(req.body?.tiktokUser);
  } catch (_) {  }

  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const userRef = db().collection('users').doc(req.uid);
  const snap = await userRef.get();
  const isNewUser = !snap.exists;

  if (isNewUser) {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    const data = DEFAULTS(req.email);
    if (name) data.profileName = name;
    if (phone) data.profilePhone = phone;
    if (tiktokName) data.tiktokName = tiktokName;
    if (tiktokUser) data.tiktokUser = tiktokUser;
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    await userRef.set(data, { merge: true });
  } else {
    const patch = {};
    const cur = snap.data();
    if (req.email && cur.email !== req.email) patch.email = req.email;
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    if (name && !cur.profileName) patch.profileName = name;
    if (phone && !cur.profilePhone) patch.profilePhone = phone;
    if (tiktokName && !cur.tiktokName) patch.tiktokName = tiktokName;
    if (tiktokUser && !cur.tiktokUser) patch.tiktokUser = tiktokUser;
    if (Object.keys(patch).length) await userRef.set(patch, { merge: true });
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  }
  invalidateUserDoc(req.uid, { history: false });
  res.json({ success: true, isNewUser });
}));

// src by SRT X CHEATS. Copy right SRT X CHEATS
router.get('/me', asyncHandler(async (req, res) => {
  const snap = await getUserDoc(req.uid);
  const data = snap.exists ? snap.data : DEFAULTS(req.email);

  res.json({
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    success: true,
    uid: req.uid,
    email: data.email || req.email,
    role: data.role || 'user',
    balance: Number(data.balance || 0),
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    totalSpent: Number(data.totalSpent || 0),
    totalKeysBought: Number(data.totalKeysBought || 0),
    requestStatus: data.requestStatus || 'Active',
  });
}));
// src by SRT X CHEATS. Copy right SRT X CHEATS

router.get('/balance', asyncHandler(async (req, res) => {
  const snap = await getUserDoc(req.uid);

  let data;
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (!snap.exists) {
    data = DEFAULTS(req.email);
    await db().collection('users').doc(req.uid).set(data, { merge: true });
    invalidateUserDoc(req.uid, { history: false });
  } else {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    data = snap.data;
  }

  res.json({
    success: true,
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    balance: Number(data.balance || 0),
    adminMessage: data.adminMessage || '',
    requestStatus: data.requestStatus || 'Active',
    profileName: data.profileName || '',
    profilePhone: data.profilePhone || '',
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    tiktokName: data.tiktokName || '',
    tiktokUser: data.tiktokUser || '',
    panelLink: data.panelLink || '',
    profileLocks: computeLocks(data),
    profileLimits: LIMITS_MS,
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    email: data.email || req.email,
    role: data.role || 'user',
    proReseller: proPublicState(data),
    totalKeysBought: Number(data.totalKeysBought || 0),
    totalSpent: Number(data.totalSpent || 0),
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    hasCompletedFirstTopup: (data.topupRequests || []).some((t) => t.status === 'APPROVED'),
    qrApproved: (() => {
      const ok = (data.topupRequests || []).filter((t) => t.method === 'QR' && t.status === 'APPROVED');
      const t = ok[ok.length - 1];
      return t ? { reqId: t.reqId, amount: Number(t.amount || 0), at: t.reviewedAt || t.date } : null;
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    })(),
    fakePayment: data.fakePayment && data.fakePayment.count
      ? { count: Number(data.fakePayment.count), max: 3, text: data.fakePayment.text || '', lastTx: data.fakePayment.lastTx || '', lastAt: data.fakePayment.lastAt || '' }
      : null,
    avatarUrl: data.avatarUrl || '',
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    policyAcknowledged: !!data.policyAcknowledged,
    welcomeRedirectDone: !!data.welcomeRedirectDone,
    minKeys: RESELLER_MIN_KEYS,
    minBalance: RESELLER_MIN_BALANCE,
  });
// src by SRT X CHEATS. Copy right SRT X CHEATS
}));

router.get('/catalog', asyncHandler(async (req, res) => {
  const snap = await getUserDoc(req.uid);
  const role = snap.exists ? (snap.data.role || 'user') : 'user';
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  res.json({ success: true, role, catalog: await getLiveCatalog(role) });
}));

router.post('/profile', asyncHandler(async (req, res) => {
  const body = req.body || {};
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  const name = String(body.name || '').trim();
  const phone = String(body.phone || '').trim();
  if (!name || !phone) {
    return res.status(400).json({ success: false, error: 'Please fill both fields' });
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  }
  if (name.length > 60 || phone.length > 30) {
    return res.status(400).json({ success: false, error: 'Name or phone is too long' });
  }

  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const userRef = db().collection('users').doc(req.uid);
  const snap = await userRef.get();
  const cur = snap.exists ? snap.data() : {};
  const now = Date.now();
  const stamps = { ...(cur.profileChangeAt || {}) };
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const update = {};

  try {
    const oldName = String(cur.profileName || '');
    if (name !== oldName) {
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      if (oldName) { assertUnlocked(cur, 'name', now); stamps.name = now; }
      update.profileName = name; update.name = name;
    }
    const oldPhone = String(cur.profilePhone || '');
    if (phone !== oldPhone) {
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      if (oldPhone) { assertUnlocked(cur, 'phone', now); stamps.phone = now; }
      update.profilePhone = phone; update.whatsapp = phone;
    }
    if (has('tiktokName')) update.tiktokName = normalizeTikTokName(body.tiktokName);
    if (has('tiktokUser')) update.tiktokUser = normalizeTikTokUser(body.tiktokUser);
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    if (has('panelLink')) {
      const link = normalizePanelLink(body.panelLink);
      if (link !== String(cur.panelLink || '')) {
        if (!isResellerTier(cur.role || 'user')) throw new RuleError('Only reseller accounts can add a panel link.', 403);
        assertUnlocked(cur, 'panelLink', now);
        // src by SRT X CHEATS. Copy right SRT X CHEATS
        stamps.panelLink = now;
        update.panelLink = link;
      }
    }
  } catch (e) {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    if (e instanceof RuleError) return res.status(e.status).json({ success: false, error: e.message, ...e.extra });
    throw e;
  }

  update.email = req.email;
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  update.profileChangeAt = stamps;
  await userRef.set(update, { merge: true });
  invalidateUserDoc(req.uid, { history: false });
  if (update.profileName) leaderboardCache.invalidate();

  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const merged = { ...cur, ...update };
  res.json({
    success: true,
    fields: {
      profileName: merged.profileName || '', profilePhone: merged.profilePhone || '',
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      tiktokName: merged.tiktokName || '', tiktokUser: merged.tiktokUser || '', panelLink: merged.panelLink || '',
    },
    locks: computeLocks(merged, now),
  });
}));
// src by SRT X CHEATS. Copy right SRT X CHEATS

router.get('/history', asyncHandler(async (req, res) => {
  const snap = await getUserDoc(req.uid);
  const purchases = snap.exists ? (snap.data.purchaseHistory || []) : [];
  res.json({ success: true, history: [...purchases].reverse() });
// src by SRT X CHEATS. Copy right SRT X CHEATS
}));

router.get('/api-history', asyncHandler(async (req, res) => {
  const snap = await db().collection('users').doc(req.uid).collection('apiOrders')
    .orderBy('createdAt', 'desc').limit(100).get();
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
  const orders = snap.docs.map((d) => {
    const o = d.data();
    const qty = Number(o.quantity || 0);
    const unit = Number(o.unitPrice || 0);
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    const paid = o.status === 'processing' ? r2(qty * unit) : r2(o.charged);
    const after = o.balanceAfter === undefined || o.balanceAfter === null ? null : r2(o.balanceAfter);
    const before = o.balanceBefore !== undefined && o.balanceBefore !== null
      ? r2(o.balanceBefore)
      : (after === null ? null : r2(after + paid));
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    return {
      orderId: o.orderId, status: o.status || 'processing', at: o.createdAt || 0,
      product: o.productRow || o.productName || '—', duration: o.durationLabel || '',
      quantity: qty, delivered: Number(o.delivered || 0), unitPrice: unit,
      paid, refunded: r2(o.refunded), balanceBefore: before, balanceAfter: after,
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      keys: Array.isArray(o.keys) ? o.keys : [],
    };
  });
  res.json({ success: true, orders });
}));
// src by SRT X CHEATS. Copy right SRT X CHEATS

router.post('/history-clear', asyncHandler(async (req, res) => {
  res.status(403).json({ success: false, error: 'Purchase history cannot be deleted.' });
}));

// src by SRT X CHEATS. Copy right SRT X CHEATS
router.post('/topup', asyncHandler(async (req,res)=>{
  const amount=parseInt(req.body?.amount,10);
  const txCode=String(req.body?.txCode||'').trim().toUpperCase();
  const paymentAccount=String(req.body?.paymentAccount||'').trim();
  if(!amount||amount<50) return res.status(400).json({success:false,error:'Enter a valid amount (minimum Rs 50)'});
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if(amount>1000000) return res.status(400).json({success:false,error:'Amount is too large'});
  if(paymentAccount!=='SRT X CHEATS (OWNER)') return res.status(400).json({success:false,error:'Invalid payment account'});
  if(!txCode) return res.status(400).json({success:false,error:'Transaction code is required'});
  if(txCode.length>120) return res.status(400).json({success:false,error:'Transaction code is too long'});
  const userRef=db().collection('users').doc(req.uid);
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  try {
    const entry=await db().runTransaction(async tx=>{
      const snap=await tx.get(userRef); const existing=snap.exists?(snap.data().topupRequests||[]):[];
      if(existing.some(t=>String(t.txCode||'').toUpperCase()===txCode)) throw new Error('This transaction ID was already submitted');
      const e={date:new Date().toISOString(),amount,paymentAccount,txCode,status:'PENDING',uid:req.uid,email:req.email};
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      tx.set(userRef,{topupRequests:[...existing,e]},{merge:true}); return e;
    });
    invalidateUserDoc(req.uid, { history: false });
    const profileSnap = await userRef.get();
    const profile = profileSnap.exists ? profileSnap.data() : {};
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    const notifyText = telegramFormat('Balance Load Request',{
      username: profile.profileName || req.email,
      email: profile.email || req.email,
      phone: profile.profilePhone || '',
      product: paymentAccount,
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      price: amount,
      uid: req.uid,
      status:'pending',
      others:`TX code: ${txCode}`
    });
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    await telegramNotify(notifyText,'balance');
    return res.json({success:true,request:entry});
  } catch(e) { res.status(409).json({success:false,error:e.message}); }
}));

// src by SRT X CHEATS. Copy right SRT X CHEATS
router.post('/topup-qr', rateLimit({ windowMs: 10 * 60_000, max: 8, name: 'topup-qr' }), asyncHandler(async (req, res) => {
  const amount = Number(req.body?.amount);
  const txCode = String(req.body?.txCode || '').trim().toUpperCase();
  if (!Number.isInteger(amount) || amount < QR_MIN_AMOUNT) return res.status(400).json({ success: false, error: `Minimum top-up is Rs ${QR_MIN_AMOUNT}` });
  if (amount > QR_MAX_AMOUNT) return res.status(400).json({ success: false, error: 'Amount is too large' });
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (!/^[A-Z0-9_-]{6,40}$/.test(txCode)) return res.status(400).json({ success: false, error: 'Enter a valid transaction ID (6-40 letters/numbers)' });

  const reqId = newReqId();
  const userRef = db().collection('users').doc(req.uid);
  const txRef = db().collection('topupTx').doc(txCode);
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const idxRef = db().collection('topupQr').doc(reqId);
  const date = new Date().toISOString();
  const ip = req.ip || '';

  let profile;
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  try {
    profile = await db().runTransaction(async (tx) => {
      const [u, used] = await Promise.all([tx.get(userRef), tx.get(txRef)]);
      if (used.exists) throw new Error('This transaction ID was already submitted');
      const d = u.exists ? u.data() : {};
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      const list = Array.isArray(d.topupRequests) ? d.topupRequests : [];
      const recentCut = Date.now() - QR_PENDING_WINDOW_MS;
      const recentPending = list.filter((t) => t.status === 'PENDING' && t.method === QR_METHOD && new Date(t.date).getTime() > recentCut);
      if (recentPending.length >= QR_MAX_PENDING) {
        const oldest = Math.min(...recentPending.map((t) => new Date(t.date).getTime()));
        // src by SRT X CHEATS. Copy right SRT X CHEATS
        const mins = Math.max(1, Math.ceil((oldest + QR_PENDING_WINDOW_MS - Date.now()) / 60000));
        throw new Error(`You already have ${recentPending.length} top-ups waiting to be checked. You can send a new one in about ${mins} min.`);
      }
      const entry = { date, amount, paymentAccount: 'QR (SRT X CHEATS)', method: QR_METHOD, txCode, status: 'PENDING', uid: req.uid, email: req.email, reqId, ip };
      tx.set(userRef, { topupRequests: [...list, entry] }, { merge: true });
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      tx.set(txRef, { uid: req.uid, reqId, at: date });
      tx.set(idxRef, { uid: req.uid, txCode, amount, status: 'PENDING', createdAt: date, messages: [] });
      return d;
    });
  } catch (e) {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    return res.status(409).json({ success: false, error: e.message });
  }
  invalidateUserDoc(req.uid, { history: false });

  try {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    const messages = await sendRequestToBot(reqId, {
      name: profile.profileName || '', uid: req.uid, email: profile.email || req.email, phone: profile.profilePhone || '',
      balance: Number(profile.balance || 0), amount, txCode, date, ip,
    });
    if (messages.length) await idxRef.set({ messages }, { merge: true });
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  } catch (e) { console.warn('[topup-qr] announce failed:', e?.name || 'error'); }

  res.json({ success: true, reqId, status: 'PENDING' });
}));

// src by SRT X CHEATS. Copy right SRT X CHEATS
router.get('/topup-history', asyncHandler(async (req, res) => {
  const snap = await getUserDoc(req.uid);
  const list = snap.exists ? (snap.data.topupRequests || []) : [];
  const payments = [...list].reverse().slice(0, 200).map((t) => ({
    date: t.date || '', amount: Number(t.amount || 0), method: t.method || 'OTHER',
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    status: t.status || 'PENDING', txCode: t.txCode || '', reviewedAt: t.reviewedAt || '',
  }));
  res.json({ success: true, payments });
}));

// src by SRT X CHEATS. Copy right SRT X CHEATS
router.get('/balance-history', asyncHandler(async (req, res) => {
  const snap = await getUserDoc(req.uid);
  const log = snap.exists ? (snap.data.adminLog || []) : [];
  res.json({ success: true, log: [...log].reverse() });
}));
// src by SRT X CHEATS. Copy right SRT X CHEATS

router.post('/report', asyncHandler(async(req,res)=>{
  const category=String(req.body?.category||'').trim(); const problem=String(req.body?.problem||'').trim();
  if(!['Balance','Unknown product','Others'].includes(category)) return res.status(400).json({success:false,error:'Choose a valid bug category'});
  if(!problem) return res.status(400).json({success:false,error:'Please describe the problem'});
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if(problem.length>1000) return res.status(400).json({success:false,error:'Please keep it under 1000 characters'});
  const snap=await getUserDoc(req.uid); const data=snap.exists?snap.data:{};
  telegramNotify(`🐛 <b>BUG REPORT</b>\n📌 Category: <b>${esc(category)}</b>\n👤 ${esc(data.profileName||'—')}\n✉️ ${esc(data.email||req.email)}\n📱 ${esc(data.profilePhone||'—')}\n💰 Rs ${esc(data.balance??0)}\n🆔 <code>${esc(req.uid)}</code>\n🌐 IP: <code>${esc(req.ip)}</code>\n📅 ${esc(new Date().toISOString())}\n📝 ${esc(problem)}`,'bug');
  res.json({success:true});
}));
// src by SRT X CHEATS. Copy right SRT X CHEATS

router.get('/leaderboard', asyncHandler(async (req, res) => {
  res.json({ success: true, leaderboard: await leaderboardCache.get() });
}));

// src by SRT X CHEATS. Copy right SRT X CHEATS
router.get('/public-profile', asyncHandler(async (req, res) => {
  const uid = String(req.query.uid || '').trim();
  if (!uid) return res.status(400).json({ success: false, error: 'Provide a uid' });

  if (isBotUid(uid)) {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    const b = await getBot(botDocId(uid));
    if (!b) return res.status(404).json({ success: false, error: 'User not found' });
    return res.json({
      success: true,
      uid,
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      avatarUrl: b.logoUrl || '',
      name: b.name,
      email: '',
      phone: b.number || '',
      tiktokName: '',
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      tiktokUser: '',
      panelLink: b.resellerLink || '',
      role: b.resellerLink ? 'reseller' : 'user',
      totalKeysBought: Number(b.keysBought || 0),
      totalSpent: Number(b.spent || 0),
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      badge: b.badge || '',
      cosmetics: botCosmetics(b),
    });
  }

  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const snap = await getUserDoc(uid);
  if (!snap.exists) return res.status(404).json({ success: false, error: 'User not found' });

  const d = snap.data;
  const worn = await cosmeticsFor([uid]).catch(() => new Map());
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  res.json({
    success: true,
    uid,
    cosmetics: worn.get(uid) || NO_COSMETICS,
    avatarUrl: d.avatarUrl || '',
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    name: d.profileName || (d.email ? d.email.split('@')[0] : 'Anonymous'),
    email: d.email || '',
    phone: d.profilePhone || '',
    tiktokName: d.tiktokName || '',
    tiktokUser: d.tiktokUser || '',
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    panelLink: (isResellerTier(d.role) && d.panelLink) ? d.panelLink : '',
    role: d.role || 'user',
    totalKeysBought: Number(d.totalKeysBought || 0),
    totalSpent: Number(d.totalSpent || 0),
  });
// src by SRT X CHEATS. Copy right SRT X CHEATS
}));

router.post('/redeem', asyncHandler(async (req, res) => {
  const raw = String(req.body?.code || '').trim().toUpperCase();
  if (!raw) return res.status(400).json({ success: false, error: 'Enter a code' });
// src by SRT X CHEATS. Copy right SRT X CHEATS

  const codeRef = db().collection('redeemCodes').doc(raw);
  const userRef = db().collection('users').doc(req.uid);

  const result = await db().runTransaction(async (tx) => {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    const codeSnap = await tx.get(codeRef);
    if (!codeSnap.exists) return { ok: false, error: 'Invalid code' };

    const c = codeSnap.data();
    if (c.active === false) return { ok: false, error: 'This code is no longer active' };
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    if (c.expiresAt && Date.now() > c.expiresAt) return { ok: false, error: 'This code has expired' };
    const redeemedBy = c.redeemedBy || [];
    if (redeemedBy.includes(req.uid)) return { ok: false, error: 'You have already redeemed this code' };
    if (c.maxUses && (c.usedCount || 0) >= c.maxUses) return { ok: false, error: 'This code has reached its usage limit' };

    // src by SRT X CHEATS. Copy right SRT X CHEATS
    const userSnap = await tx.get(userRef);
    const currentBalance = Number(userSnap.data()?.balance || 0);
    const amount = Number(c.amount || 0);
    const newBalance = currentBalance + amount;

    // src by SRT X CHEATS. Copy right SRT X CHEATS
    tx.set(userRef, { balance: newBalance }, { merge: true });
    tx.set(codeRef, {
      usedCount: admin.firestore.FieldValue.increment(1),
      redeemedBy: admin.firestore.FieldValue.arrayUnion(req.uid),
    }, { merge: true });
// src by SRT X CHEATS. Copy right SRT X CHEATS

    return { ok: true, amount, newBalance };
  });

  if (!result.ok) return res.status(400).json({ success: false, error: result.error });
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  invalidateUserDoc(req.uid, { history: false, balance: result.newBalance });
  res.json({ success: true, amountCredited: result.amount, newBalance: result.newBalance });
}));

router.get('/announcement', asyncHandler(async (req, res) => {
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const active = await announcementCache.get();
  if (active.length === 0) return res.json({ success: true, announcement: null });

  const ann = [...active].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];

  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const userSnap = await getUserDoc(req.uid);
  const lastSeen = userSnap.exists ? userSnap.data.lastSeenAnnouncementId : null;
  if (lastSeen === ann.id) return res.json({ success: true, announcement: null });

  res.json({ success: true, announcement: { id: ann.id, message: ann.message, giftCode: ann.giftCode || null, giftAmount: ann.giftAmount || null } });
// src by SRT X CHEATS. Copy right SRT X CHEATS
}));

router.post('/announcement/seen', asyncHandler(async (req, res) => {
  const id = String(req.body?.id || '').trim();
  if (!id) return res.status(400).json({ success: false, error: 'Provide an announcement id' });
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  await db().collection('users').doc(req.uid).set({ lastSeenAnnouncementId: id }, { merge: true });
  invalidateUserDoc(req.uid, { history: false });
  res.json({ success: true });
}));

// src by SRT X CHEATS. Copy right SRT X CHEATS
router.post('/feedback', asyncHandler(async (req, res) => {
  const row = String(req.body?.row || '').trim();
  const stars = Number(req.body?.stars);
  const comment = String(req.body?.comment || '').trim().slice(0, 500);
  const authorName = String(req.body?.authorName || '').trim().slice(0, 60) || 'Anonymous';
// src by SRT X CHEATS. Copy right SRT X CHEATS

  if (!row) return res.status(400).json({ success: false, error: 'Missing product' });
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    return res.status(400).json({ success: false, error: 'Rating must be 1-5 stars' });
  }
// src by SRT X CHEATS. Copy right SRT X CHEATS

  const userSnap = await getUserDoc(req.uid);
  const purchaseHistory = userSnap.exists ? (userSnap.data.purchaseHistory || []) : [];

  const catalog = await getLiveCatalog('user');
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const namesForRow = new Set(Object.values(catalog).filter((p) => p.row === row).map((p) => p.name));
  const verified = purchaseHistory.some((h) => h.row === row || namesForRow.has(h.name));
  if (!verified) {
    return res.status(403).json({ success: false, error: "You can only review products you've purchased" });
  }
// src by SRT X CHEATS. Copy right SRT X CHEATS

  const id = `${req.uid}_${row}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
  const feedbackDoc = { uid: req.uid, authorName, row, stars, comment, createdAt: Date.now() };
  await db().collection('feedback').doc(id).set(feedbackDoc);

  // src by SRT X CHEATS. Copy right SRT X CHEATS
  recordFeedback(id, feedbackDoc);
  res.json({ success: true });
}));

router.get('/feedback', asyncHandler(async (req, res) => {
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const row = req.query.row ? String(req.query.row) : null;
  res.json({ success: true, feedback: await getFeedbackList({ row, limit: 300 }) });
}));

const RESELLER_MIN_KEYS = 8;
// src by SRT X CHEATS. Copy right SRT X CHEATS
const RESELLER_MIN_BALANCE = 1500;

router.post('/apply-reseller', asyncHandler(async (req, res) => {
  const userRef = db().collection('users').doc(req.uid);

  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const result = await db().runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    const data = snap.exists ? snap.data() : {};

    if (isResellerTier(data.role || 'user')) {
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      return { ok: false, error: 'You are already a reseller' };
    }

    const totalKeysBought = Number(data.totalKeysBought || 0);
    const balance = Number(data.balance || 0);
// src by SRT X CHEATS. Copy right SRT X CHEATS

    if (totalKeysBought < RESELLER_MIN_KEYS || balance < RESELLER_MIN_BALANCE) {
      return {
        ok: false,
        error: `Not eligible yet — need ${RESELLER_MIN_KEYS}+ keys bought (you have ${totalKeysBought}) and NRP ${RESELLER_MIN_BALANCE}+ balance (you have NRP ${balance}).`,
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      };
    }

    const log = data.adminLog || [];
    log.push({
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      delta: 0,
      note: `Self-upgraded to reseller (${totalKeysBought} keys, NRP ${balance} balance)`,
      resultingBalance: balance,
      at: new Date().toISOString(),
    });
// src by SRT X CHEATS. Copy right SRT X CHEATS

    tx.set(userRef, { role: 'reseller', adminLog: log }, { merge: true });
    return { ok: true, totalKeysBought, balance };
  });

  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (!result.ok) return res.status(400).json({ success: false, error: result.error });
  invalidateUserDoc(req.uid, { history: false });

  telegramNotify(
    `👑 <b>RESELLER SELF-UPGRADE</b>\n` +
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    `UID: <code>${esc(req.uid)}</code>\n` +
    `Email: ${esc(req.email)}\n` +
    `Keys bought: ${result.totalKeysBought}\n` +
    `Balance: NRP ${result.balance}`
  );
// src by SRT X CHEATS. Copy right SRT X CHEATS

  res.json({ success: true, role: 'reseller' });
}));

router.get('/reseller-progress', asyncHandler(async (req, res) => {
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const snap = await getUserDoc(req.uid);
  const data = snap.exists ? snap.data : {};
  const totalKeysBought = Number(data.totalKeysBought || 0);
  const balance = Number(data.balance || 0);
  res.json({
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    success: true,
    role: data.role || 'user',
    totalKeysBought,
    balance,
    minKeys: RESELLER_MIN_KEYS,
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    minBalance: RESELLER_MIN_BALANCE,
    eligible: (data.role || 'user') === 'user' && totalKeysBought >= RESELLER_MIN_KEYS && balance >= RESELLER_MIN_BALANCE,
  });
}));

// src by SRT X CHEATS. Copy right SRT X CHEATS
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);

router.post('/pro-reseller/apply', rateLimit({ windowMs: 10 * 60_000, max: 6, name: 'pro-apply' }), asyncHandler(async (req, res) => {
  const name = clean(req.body?.name, 60);
  const whatsapp = clean(req.body?.whatsapp, 20).replace(/[^\d+]/g, '');
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const phone = clean(req.body?.phone, 20).replace(/[^\d+]/g, '');
  const tiktok = clean(req.body?.tiktok, 40).replace(/^@+/, '');
  if (!name || !whatsapp || !phone || !tiktok) return res.status(400).json({ success: false, error: 'Please fill all 4 fields' });
  if (name.length < 2) return res.status(400).json({ success: false, error: 'Enter your full name' });
  if (whatsapp.replace(/\D/g, '').length < 7 || phone.replace(/\D/g, '').length < 7) {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    return res.status(400).json({ success: false, error: 'Enter valid WhatsApp business and phone numbers' });
  }
  if (!/^[A-Za-z0-9._]{2,40}$/.test(tiktok)) return res.status(400).json({ success: false, error: 'Enter your TikTok id (letters, numbers, . and _ only)' });

  const reqId = newProReqId();
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const userRef = db().collection('users').doc(req.uid);
  const idxRef = db().collection('proRequests').doc(reqId);
  const now = new Date().toISOString();

  let user;
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  try {
    user = await db().runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      const d = snap.exists ? snap.data() : {};
      const pr = d.proReseller || {};
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      if ((d.role || 'user') === 'pro_reseller' || pr.status === 'active') throw new Error('You are already a PRO RESELLER');
      if ((d.role || 'user') !== 'reseller') throw new Error('Unlock RESELLER mode first, then you can send your details for PRO RESELLER approval');
      if (pr.status === 'pending') throw new Error('Your details are already being verified by admin');
      if (pr.status === 'approved') throw new Error('You are already approved — just top up to activate PRO RESELLER');
      tx.set(userRef, {
        // src by SRT X CHEATS. Copy right SRT X CHEATS
        proReseller: { status: 'pending', reqId, requestedAt: now, details: { name, whatsapp, phone, tiktok }, requiredDeposit: PRO_MIN_TOPUP, depositSinceApproval: 0 },
      }, { merge: true });
      tx.set(idxRef, { uid: req.uid, status: 'PENDING', createdAt: now, messages: [] });
      return d;
    });
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  } catch (e) {
    return res.status(e.message.startsWith('Unlock RESELLER') ? 403 : 409).json({ success: false, error: e.message });
  }
  invalidateUserDoc(req.uid, { history: false });

  // src by SRT X CHEATS. Copy right SRT X CHEATS
  try {
    const messages = await sendProRequestToBot(reqId, {
      storeName: user.profileName || '', email: user.email || req.email, uid: req.uid, name, whatsapp, phone, tiktok,
    });
    if (messages.length) await idxRef.set({ messages }, { merge: true });
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  } catch (e) { console.warn('[pro-reseller] announce failed:', e?.name || 'error'); }

  res.json({ success: true, status: 'pending' });
}));

// src by SRT X CHEATS. Copy right SRT X CHEATS
router.get('/pro-reseller', asyncHandler(async (req, res) => {
  const snap = await getUserDoc(req.uid);
  const d = snap.exists ? snap.data : {};
  res.json({ success: true, role: d.role || 'user', ...proPublicState(d) });
}));
// src by SRT X CHEATS. Copy right SRT X CHEATS

const lastAvatarUpload = new Map();
router.post('/avatar', asyncHandler(async (req, res) => {
  const now = Date.now();
  if (now - (lastAvatarUpload.get(req.uid) || 0) < 10_000) {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    return res.status(429).json({ success: false, error: 'Please wait a few seconds before uploading again.' });
  }

  const userRef = db().collection('users').doc(req.uid);
  const cur = (await userRef.get()).data() || {};
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  try { assertUnlocked(cur, 'avatar', now); }
  catch (e) { return res.status(e.status || 429).json({ success: false, error: e.message, ...(e.extra || {}) }); }

  lastAvatarUpload.set(req.uid, now);
  let url;
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  try {
    url = await uploadAvatar(String(req.body?.image || ''), req.uid);
  } catch (e) {
    lastAvatarUpload.delete(req.uid);
    return res.status(e.status || 502).json({ success: false, error: e.message });
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  }
  const stamps = { ...(cur.profileChangeAt || {}), avatar: Date.now() };
  await userRef.set({ avatarUrl: url, profileChangeAt: stamps }, { merge: true });
  invalidateUserDoc(req.uid, { history: false });
  leaderboardCache.invalidate();
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  res.json({ success: true, avatarUrl: url, locks: computeLocks({ profileChangeAt: stamps }) });
}));

router.delete('/avatar', asyncHandler(async (req, res) => {
  const now = Date.now();
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const userRef = db().collection('users').doc(req.uid);
  const cur = (await userRef.get()).data() || {};
  try { assertUnlocked(cur, 'avatar', now); }
  catch (e) { return res.status(e.status || 429).json({ success: false, error: e.message, ...(e.extra || {}) }); }
  const stamps = { ...(cur.profileChangeAt || {}), avatar: now };
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  await userRef.set({ avatarUrl: '', profileChangeAt: stamps }, { merge: true });
  invalidateUserDoc(req.uid, { history: false });
  leaderboardCache.invalidate();
  res.json({ success: true, avatarUrl: '', locks: computeLocks({ profileChangeAt: stamps }, now) });
}));
// src by SRT X CHEATS. Copy right SRT X CHEATS

router.get('/sync', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, versions: getVersions(req.uid) });
});
// src by SRT X CHEATS. Copy right SRT X CHEATS

router.get('/policy-ack', asyncHandler(async (req, res) => {
  const snap = await getUserDoc(req.uid);
  const data = snap.exists ? snap.data : {};
  res.json({ success: true, acknowledged: !!data.policyAcknowledged });
// src by SRT X CHEATS. Copy right SRT X CHEATS
}));

router.post('/policy-ack', asyncHandler(async (req, res) => {
  await db().collection('users').doc(req.uid).set({
    policyAcknowledged: true,
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    policyAcknowledgedAt: Date.now(),
  }, { merge: true });
  invalidateUserDoc(req.uid, { history: false });
  res.json({ success: true });
}));
// src by SRT X CHEATS. Copy right SRT X CHEATS

router.get('/welcome-redirect', asyncHandler(async (req, res) => {
  const snap = await getUserDoc(req.uid);
  const data = snap.exists ? snap.data : {};
  if (data.welcomeRedirectDone) return res.json({ success: true, show: false });
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const cfg = await db().collection('config').doc('welcomePopup').get();
  const c = cfg.exists ? cfg.data() : {};
  const url = /^https?:\/\//i.test(String(c.url || '')) ? String(c.url) : '';
  res.json({ success: true, show: c.enabled !== false, url });
}));
// src by SRT X CHEATS. Copy right SRT X CHEATS

router.post('/welcome-redirect', asyncHandler(async (req, res) => {
  await db().collection('users').doc(req.uid).set({
    welcomeRedirectDone: true,
    welcomeRedirectAt: Date.now(),
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  }, { merge: true });
  invalidateUserDoc(req.uid, { history: false });
  res.json({ success: true });
}));

// src by SRT X CHEATS. Copy right SRT X CHEATS
export default router;
