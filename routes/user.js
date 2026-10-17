import express from 'express';
import admin from 'firebase-admin';
import { asyncHandler } from '../src/asyncHandler.js';
import { db, requireFirebaseUid, userCors } from '../src/firebase.js';
import { telegramNotify, telegramFormat, esc } from '../src/telegram.js';
import { getLiveCatalog, getFeedbackList, recordFeedback } from '../src/catalog.js';
import { leaderboardCache, announcementCache } from '../src/sharedCaches.js';
import { uploadAvatar } from '../src/imgbb.js';
import { getVersions } from '../src/versions.js';
import {
  LIMITS_MS, computeLocks, assertUnlocked, RuleError,
  normalizePanelLink, normalizeTikTokUser, normalizeTikTokName,
} from '../src/profileRules.js';
import { getUserDoc, invalidateUserDoc } from '../src/userCache.js';
import { isBotUid, botDocId, getBot } from '../src/leaderboardBots.js';
import { rateLimit } from '../src/security.js';
import { isResellerTier, proPublicState, PRO_MIN_TOPUP } from '../src/proTier.js';
import { sendProRequestToBot } from '../src/proReseller.js';
import { newReqId as newProReqId } from '../src/topupQr.js';
import {
  QR_MIN_AMOUNT, QR_MAX_AMOUNT, QR_MAX_PENDING, QR_PENDING_WINDOW_MS, QR_METHOD, newReqId, sendRequestToBot,
} from '../src/topupQr.js';

const router = express.Router();
router.use(userCors);
router.use(requireFirebaseUid);

const DEFAULTS = (email) => ({
  email,
  role: 'user', // 'user' (retail) | 'reseller' | 'pro_reseller' (lowest price) - changed by admin / bot / pro-reseller flow only
  profileName: '',
  profilePhone: '',
  tiktokName: '',
  tiktokUser: '',
  panelLink: '',
  avatarUrl: '',
  requestStatus: 'Active',
  adminMessage: 'Welcome! Pay via eSewa or Balance to get your key 🔑',
  balance: 0,
  purchaseHistory: [],
  totalKeysBought: 0,
  totalSpent: 0,
});

// POST /api/user/init — called once right after signup/Google sign-in.
// Optionally accepts { name, phone, tiktok } collected on the
// registration form, so a brand-new account is created with its
// profile already filled in (Google sign-in doesn't send these, so
// it just omits the body and profile stays blank until /profile is
// called from the "complete your profile" prompt).
router.post('/init', asyncHandler(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const phone = String(req.body?.phone || '').trim();
  let tiktokName = '', tiktokUser = '';
  try {
    tiktokName = normalizeTikTokName(req.body?.tiktokName);
    tiktokUser = normalizeTikTokUser(req.body?.tiktokUser);
  } catch (_) { /* signup extras are best-effort; the profile page validates strictly */ }

  const userRef = db().collection('users').doc(req.uid);
  const snap = await userRef.get();
  const isNewUser = !snap.exists;

  if (isNewUser) {
    const data = DEFAULTS(req.email);
    if (name) data.profileName = name;
    if (phone) data.profilePhone = phone;
    if (tiktokName) data.tiktokName = tiktokName;
    if (tiktokUser) data.tiktokUser = tiktokUser;
    await userRef.set(data, { merge: true });
  } else {
    const patch = {};
    const cur = snap.data();
    if (req.email && cur.email !== req.email) patch.email = req.email;
    // Only fill in fields that are still blank — never clobber values
    // the user already saved from their profile page.
    if (name && !cur.profileName) patch.profileName = name;
    if (phone && !cur.profilePhone) patch.profilePhone = phone;
    if (tiktokName && !cur.tiktokName) patch.tiktokName = tiktokName;
    if (tiktokUser && !cur.tiktokUser) patch.tiktokUser = tiktokUser;
    if (Object.keys(patch).length) await userRef.set(patch, { merge: true });
  }
  invalidateUserDoc(req.uid);
  // isNewUser is derived purely from "did a Firestore doc already exist
  // for this uid" — not a client-sent flag.
  res.json({ success: true, isNewUser });
}));

// GET /api/user/me — a lean account summary. uid/email/role come
// straight off the verified token or Firestore — never client-supplied.
router.get('/me', asyncHandler(async (req, res) => {
  const snap = await getUserDoc(req.uid);
  const data = snap.exists ? snap.data : DEFAULTS(req.email);

  res.json({
    success: true,
    uid: req.uid,
    email: data.email || req.email,
    role: data.role || 'user',
    balance: Number(data.balance || 0),
    totalSpent: Number(data.totalSpent || 0),
    totalKeysBought: Number(data.totalKeysBought || 0),
    requestStatus: data.requestStatus || 'Active',
  });
}));

// GET /api/user/balance — the single state call the frontend polls.
router.get('/balance', asyncHandler(async (req, res) => {
  const snap = await getUserDoc(req.uid);

  let data;
  if (!snap.exists) {
    data = DEFAULTS(req.email);
    await db().collection('users').doc(req.uid).set(data, { merge: true });
    invalidateUserDoc(req.uid); // next read (cached or not) must see the doc we just created
  } else {
    data = snap.data;
  }

  res.json({
    success: true,
    balance: Number(data.balance || 0),
    adminMessage: data.adminMessage || '',
    requestStatus: data.requestStatus || 'Active',
    profileName: data.profileName || '',
    profilePhone: data.profilePhone || '',
    tiktokName: data.tiktokName || '',
    tiktokUser: data.tiktokUser || '',
    panelLink: data.panelLink || '',
    profileLocks: computeLocks(data),
    profileLimits: LIMITS_MS,
    email: data.email || req.email,
    role: data.role || 'user',
    proReseller: proPublicState(data),
    totalKeysBought: Number(data.totalKeysBought || 0),
    totalSpent: Number(data.totalSpent || 0),
    hasCompletedFirstTopup: (data.topupRequests || []).some((t) => t.status === 'APPROVED'),
    // Newest QR top-up that was approved (Load ✅). The browser shows "your order has been
    // completed" once per reqId (remembered locally) — no extra request or write needed.
    qrApproved: (() => {
      const ok = (data.topupRequests || []).filter((t) => t.method === 'QR' && t.status === 'APPROVED');
      const t = ok[ok.length - 1];
      return t ? { reqId: t.reqId, amount: Number(t.amount || 0), at: t.reviewedAt || t.date } : null;
    })(),
    // Fake-payment strikes from cancelled QR top-ups. Shown as a warning on the
    // store/top-up pages. count 0 / null = clean account.
    fakePayment: data.fakePayment && data.fakePayment.count
      ? { count: Number(data.fakePayment.count), max: 3, text: data.fakePayment.text || '', lastTx: data.fakePayment.lastTx || '', lastAt: data.fakePayment.lastAt || '' }
      : null,
    // Extra fields so the browser cache can answer these WITHOUT more
    // requests: avatar for the drawer/profile, the policy flag for the
    // dashboard modal, and the reseller thresholds so the dashboard's
    // progress card is computed locally from the cached profile.
    avatarUrl: data.avatarUrl || '',
    policyAcknowledged: !!data.policyAcknowledged,
    welcomeRedirectDone: !!data.welcomeRedirectDone,
    minKeys: RESELLER_MIN_KEYS,
    minBalance: RESELLER_MIN_BALANCE,
  });
}));

// GET /api/user/catalog — same shape as the public /api/catalog, but
// returns the RESELLER catalog if this uid's role is 'reseller',
// otherwise the normal retail catalog. This is what the storefront
// should call instead of the public endpoint, so pricing reflects
// the user's actual role. Role is read fresh from Firestore every
// call (not from a token claim), so an admin's role change takes
// effect on the user's very next page load/poll.
router.get('/catalog', asyncHandler(async (req, res) => {
  const snap = await getUserDoc(req.uid);
  const role = snap.exists ? (snap.data.role || 'user') : 'user';
  res.json({ success: true, role, catalog: await getLiveCatalog(role) });
}));

// POST /api/user/profile
// Body: { name, phone, tiktokName?, tiktokUser?, panelLink? }
// Name / phone / panel link are rate-limited per field (see src/profileRules.js);
// a field that is unchanged never counts as a change.
router.post('/profile', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  const name = String(body.name || '').trim();
  const phone = String(body.phone || '').trim();
  if (!name || !phone) {
    return res.status(400).json({ success: false, error: 'Please fill both fields' });
  }
  if (name.length > 60 || phone.length > 30) {
    return res.status(400).json({ success: false, error: 'Name or phone is too long' });
  }

  const userRef = db().collection('users').doc(req.uid);
  const snap = await userRef.get(); // fresh read: limits must be checked against the real stored values
  const cur = snap.exists ? snap.data() : {};
  const now = Date.now();
  const stamps = { ...(cur.profileChangeAt || {}) };
  const update = {};

  try {
    // ---- name (1 / 7 days) ----
    const oldName = String(cur.profileName || '');
    if (name !== oldName) {
      if (oldName) { assertUnlocked(cur, 'name', now); stamps.name = now; } // first fill is free
      update.profileName = name; update.name = name;
    }
    // ---- WhatsApp number (1 / 2 days) ----
    const oldPhone = String(cur.profilePhone || '');
    if (phone !== oldPhone) {
      if (oldPhone) { assertUnlocked(cur, 'phone', now); stamps.phone = now; }
      update.profilePhone = phone; update.whatsapp = phone;
    }
    // ---- TikTok name + username (no limit) ----
    if (has('tiktokName')) update.tiktokName = normalizeTikTokName(body.tiktokName);
    if (has('tiktokUser')) update.tiktokUser = normalizeTikTokUser(body.tiktokUser);
    // ---- own panel link (resellers only, 1 / day) ----
    if (has('panelLink')) {
      const link = normalizePanelLink(body.panelLink);
      if (link !== String(cur.panelLink || '')) {
        if (!isResellerTier(cur.role || 'user')) throw new RuleError('Only reseller accounts can add a panel link.', 403);
        assertUnlocked(cur, 'panelLink', now);
        stamps.panelLink = now;
        update.panelLink = link;
      }
    }
  } catch (e) {
    if (e instanceof RuleError) return res.status(e.status).json({ success: false, error: e.message, ...e.extra });
    throw e;
  }

  update.email = req.email;
  update.profileChangeAt = stamps;
  await userRef.set(update, { merge: true });
  invalidateUserDoc(req.uid);
  if (update.profileName) leaderboardCache.invalidate(); // new name must show on the leaderboard too

  const merged = { ...cur, ...update };
  res.json({
    success: true,
    fields: {
      profileName: merged.profileName || '', profilePhone: merged.profilePhone || '',
      tiktokName: merged.tiktokName || '', tiktokUser: merged.tiktokUser || '', panelLink: merged.panelLink || '',
    },
    locks: computeLocks(merged, now),
  });
}));

// GET /api/user/history
router.get('/history', asyncHandler(async (req, res) => {
  const snap = await getUserDoc(req.uid);
  const purchases = snap.exists ? (snap.data.purchaseHistory || []) : [];
  res.json({ success: true, history: [...purchases].reverse() });
}));

// POST /api/user/history-clear (disabled — see below)
// Purchase history is permanent — users can no longer delete it.
router.post('/history-clear', asyncHandler(async (req, res) => {
  res.status(403).json({ success: false, error: 'Purchase history cannot be deleted.' });
}));

// POST /api/user/topup { amount, txCode, paymentAccount }
router.post('/topup', asyncHandler(async (req,res)=>{
  const amount=parseInt(req.body?.amount,10);
  const txCode=String(req.body?.txCode||'').trim().toUpperCase();
  const paymentAccount=String(req.body?.paymentAccount||'').trim();
  if(!amount||amount<50) return res.status(400).json({success:false,error:'Enter a valid amount (minimum Rs 50)'});
  if(amount>1000000) return res.status(400).json({success:false,error:'Amount is too large'});
  if(paymentAccount!=='SRT X CHEATS (OWNER)') return res.status(400).json({success:false,error:'Invalid payment account'});
  if(!txCode) return res.status(400).json({success:false,error:'Transaction code is required'});
  if(txCode.length>120) return res.status(400).json({success:false,error:'Transaction code is too long'});
  const userRef=db().collection('users').doc(req.uid);
  try {
    const entry=await db().runTransaction(async tx=>{
      const snap=await tx.get(userRef); const existing=snap.exists?(snap.data().topupRequests||[]):[];
      if(existing.some(t=>String(t.txCode||'').toUpperCase()===txCode)) throw new Error('This transaction ID was already submitted');
      const e={date:new Date().toISOString(),amount,paymentAccount,txCode,status:'PENDING',uid:req.uid,email:req.email};
      tx.set(userRef,{topupRequests:[...existing,e]},{merge:true}); return e;
    });
    invalidateUserDoc(req.uid);
    const profileSnap = await userRef.get();
    const profile = profileSnap.exists ? profileSnap.data() : {};
    const notifyText = telegramFormat('Balance Load Request',{
      username: profile.profileName || req.email,
      email: profile.email || req.email,
      phone: profile.profilePhone || '',
      product: paymentAccount,
      price: amount,
      uid: req.uid,
      status:'pending',
      others:`TX code: ${txCode}`
    });
    await telegramNotify(notifyText,'balance');
    return res.json({success:true,request:entry});
  } catch(e) { res.status(409).json({success:false,error:e.message}); }
}));

// POST /api/user/topup-qr { amount, txCode }
// QR top-up: user paid the QR, now sends the transaction ID. We store a PENDING
// request, then post it to the owner's Telegram bot with [Load ✅] [Cancel ❌].
// Load credits the balance, Cancel counts as a fake-payment strike (see src/topupQr.js).
router.post('/topup-qr', rateLimit({ windowMs: 10 * 60_000, max: 8, name: 'topup-qr' }), asyncHandler(async (req, res) => {
  const amount = Number(req.body?.amount);
  const txCode = String(req.body?.txCode || '').trim().toUpperCase();
  if (!Number.isInteger(amount) || amount < QR_MIN_AMOUNT) return res.status(400).json({ success: false, error: `Minimum top-up is Rs ${QR_MIN_AMOUNT}` });
  if (amount > QR_MAX_AMOUNT) return res.status(400).json({ success: false, error: 'Amount is too large' });
  if (!/^[A-Z0-9_-]{6,40}$/.test(txCode)) return res.status(400).json({ success: false, error: 'Enter a valid transaction ID (6-40 letters/numbers)' });

  const reqId = newReqId();
  const userRef = db().collection('users').doc(req.uid);
  const txRef = db().collection('topupTx').doc(txCode);      // one transaction ID can only ever be used once, across ALL accounts
  const idxRef = db().collection('topupQr').doc(reqId);
  const date = new Date().toISOString();
  const ip = req.ip || '';

  let profile;
  try {
    profile = await db().runTransaction(async (tx) => {
      const [u, used] = await Promise.all([tx.get(userRef), tx.get(txRef)]);
      if (used.exists) throw new Error('This transaction ID was already submitted');
      const d = u.exists ? u.data() : {};
      const list = Array.isArray(d.topupRequests) ? d.topupRequests : [];
      // Only RECENT QR requests count. Old accounts carry stale PENDING entries from the previous
      // top-up flow (never reviewed) — those must not block new top-ups.
      const recentCut = Date.now() - QR_PENDING_WINDOW_MS;
      const recentPending = list.filter((t) => t.status === 'PENDING' && t.method === QR_METHOD && new Date(t.date).getTime() > recentCut);
      if (recentPending.length >= QR_MAX_PENDING) {
        const oldest = Math.min(...recentPending.map((t) => new Date(t.date).getTime()));
        const mins = Math.max(1, Math.ceil((oldest + QR_PENDING_WINDOW_MS - Date.now()) / 60000));
        throw new Error(`You already have ${recentPending.length} top-ups waiting to be checked. You can send a new one in about ${mins} min.`);
      }
      const entry = { date, amount, paymentAccount: 'QR (SRT X CHEATS)', method: QR_METHOD, txCode, status: 'PENDING', uid: req.uid, email: req.email, reqId, ip };
      tx.set(userRef, { topupRequests: [...list, entry] }, { merge: true });
      tx.set(txRef, { uid: req.uid, reqId, at: date });
      tx.set(idxRef, { uid: req.uid, txCode, amount, status: 'PENDING', createdAt: date, messages: [] });
      return d;
    });
  } catch (e) {
    return res.status(409).json({ success: false, error: e.message });
  }
  invalidateUserDoc(req.uid);

  // Announce to the owner's bot. A Telegram outage must not fail the user's request
  // (it is saved as PENDING and also visible in the admin panel).
  try {
    const messages = await sendRequestToBot(reqId, {
      name: profile.profileName || '', uid: req.uid, email: profile.email || req.email, phone: profile.profilePhone || '',
      balance: Number(profile.balance || 0), amount, txCode, date, ip,
    });
    if (messages.length) await idxRef.set({ messages }, { merge: true });
  } catch (e) { console.warn('[topup-qr] announce failed:', e?.name || 'error'); }

  res.json({ success: true, reqId, status: 'PENDING' });
}));

// GET /api/user/topup-history — the user's own payment (top-up) requests, newest first.
// Only safe display fields are returned.
router.get('/topup-history', asyncHandler(async (req, res) => {
  const snap = await getUserDoc(req.uid);
  const list = snap.exists ? (snap.data.topupRequests || []) : [];
  const payments = [...list].reverse().slice(0, 200).map((t) => ({
    date: t.date || '', amount: Number(t.amount || 0), method: t.method || 'OTHER',
    status: t.status || 'PENDING', txCode: t.txCode || '', reviewedAt: t.reviewedAt || '',
  }));
  res.json({ success: true, payments });
}));

// GET /api/user/balance-history — the user's own deposit/adjustment
// log (top-up approvals, admin corrections). Different from
// /history, which is what they bought, not what was added to balance.
router.get('/balance-history', asyncHandler(async (req, res) => {
  const snap = await getUserDoc(req.uid);
  const log = snap.exists ? (snap.data.adminLog || []) : [];
  res.json({ success: true, log: [...log].reverse() });
}));

// POST /api/user/report { category, problem }
router.post('/report', asyncHandler(async(req,res)=>{
  const category=String(req.body?.category||'').trim(); const problem=String(req.body?.problem||'').trim();
  if(!['Balance','Unknown product','Others'].includes(category)) return res.status(400).json({success:false,error:'Choose a valid bug category'});
  if(!problem) return res.status(400).json({success:false,error:'Please describe the problem'});
  if(problem.length>1000) return res.status(400).json({success:false,error:'Please keep it under 1000 characters'});
  const snap=await getUserDoc(req.uid); const data=snap.exists?snap.data:{};
  telegramNotify(`🐛 <b>BUG REPORT</b>\n📌 Category: <b>${esc(category)}</b>\n👤 ${esc(data.profileName||'—')}\n✉️ ${esc(data.email||req.email)}\n📱 ${esc(data.profilePhone||'—')}\n💰 Rs ${esc(data.balance??0)}\n🆔 <code>${esc(req.uid)}</code>\n🌐 IP: <code>${esc(req.ip)}</code>\n📅 ${esc(new Date().toISOString())}\n📝 ${esc(problem)}`,'bug');
  res.json({success:true});
}));

// GET /api/user/leaderboard — top 10 users by lifetime keys bought.
// Only ever exposes name + counts, never email/phone/balance, since
// every logged-in user can see this list.
//
// The result is IDENTICAL for every caller (it's not scoped to req.uid),
// so it's cached for a short, fixed window rather than per-user — one
// 10-doc query serves every dashboard load in that window instead of
// one 10-doc query PER load. 20s is imperceptible for a leaderboard.
router.get('/leaderboard', asyncHandler(async (req, res) => {
  res.json({ success: true, leaderboard: await leaderboardCache.get() });
}));

// GET /api/user/public-profile?uid=... — the "view profile" card any
// logged-in user can open from the leaderboard. Shows this platform's
// own account fields (name/email/phone/tiktok/stats) — not sensitive
// admin data like balance, adminLog or full purchase history.
router.get('/public-profile', asyncHandler(async (req, res) => {
  const uid = String(req.query.uid || '').trim();
  if (!uid) return res.status(400).json({ success: false, error: 'Provide a uid' });

  // Admin-made promo entry on the leaderboard (not a real account).
  if (isBotUid(uid)) {
    const b = await getBot(botDocId(uid));
    if (!b) return res.status(404).json({ success: false, error: 'User not found' });
    return res.json({
      success: true,
      uid,
      avatarUrl: b.logoUrl || '',
      name: b.name,
      email: '',
      phone: b.number || '',
      tiktokName: '',
      tiktokUser: '',
      panelLink: b.resellerLink || '',
      role: b.resellerLink ? 'reseller' : 'user',
      totalKeysBought: Number(b.keysBought || 0),
      totalSpent: Number(b.spent || 0),
      badge: b.badge || '',
    });
  }

  const snap = await getUserDoc(uid);
  if (!snap.exists) return res.status(404).json({ success: false, error: 'User not found' });

  const d = snap.data;
  res.json({
    success: true,
    uid,
    avatarUrl: d.avatarUrl || '',
    name: d.profileName || (d.email ? d.email.split('@')[0] : 'Anonymous'),
    email: d.email || '',
    phone: d.profilePhone || '',
    tiktokName: d.tiktokName || '',
    tiktokUser: d.tiktokUser || '',
    panelLink: (isResellerTier(d.role) && d.panelLink) ? d.panelLink : '',
    role: d.role || 'user',
    totalKeysBought: Number(d.totalKeysBought || 0),
    totalSpent: Number(d.totalSpent || 0),
  });
}));

// POST /api/user/redeem — redeem an admin-created gift/promo code.
// Body: { code }. Credits the code's Rs amount to the caller's balance,
// once per user per code, respecting the code's expiry and max-uses
// limit (both set by the admin when the code was created).
router.post('/redeem', asyncHandler(async (req, res) => {
  const raw = String(req.body?.code || '').trim().toUpperCase();
  if (!raw) return res.status(400).json({ success: false, error: 'Enter a code' });

  const codeRef = db().collection('redeemCodes').doc(raw);
  const userRef = db().collection('users').doc(req.uid);

  const result = await db().runTransaction(async (tx) => {
    const codeSnap = await tx.get(codeRef);
    if (!codeSnap.exists) return { ok: false, error: 'Invalid code' };

    const c = codeSnap.data();
    if (c.active === false) return { ok: false, error: 'This code is no longer active' };
    if (c.expiresAt && Date.now() > c.expiresAt) return { ok: false, error: 'This code has expired' };
    const redeemedBy = c.redeemedBy || [];
    if (redeemedBy.includes(req.uid)) return { ok: false, error: 'You have already redeemed this code' };
    if (c.maxUses && (c.usedCount || 0) >= c.maxUses) return { ok: false, error: 'This code has reached its usage limit' };

    const userSnap = await tx.get(userRef);
    const currentBalance = Number(userSnap.data()?.balance || 0);
    const amount = Number(c.amount || 0);
    const newBalance = currentBalance + amount;

    tx.set(userRef, { balance: newBalance }, { merge: true });
    tx.set(codeRef, {
      usedCount: admin.firestore.FieldValue.increment(1),
      redeemedBy: admin.firestore.FieldValue.arrayUnion(req.uid),
    }, { merge: true });

    return { ok: true, amount, newBalance };
  });

  if (!result.ok) return res.status(400).json({ success: false, error: result.error });
  invalidateUserDoc(req.uid);
  res.json({ success: true, amountCredited: result.amount, newBalance: result.newBalance });
}));

// GET /api/user/announcement — the current active broadcast, if this
// user hasn't seen it yet (tracked via users/{uid}.lastSeenAnnouncementId,
// not a growing array on the announcement itself). Returns
// { announcement: null } once seen or if nothing is active.
//
// Deliberately NOT using .where('active','==',true).orderBy('createdAt')
// together — Firestore requires a manually-deployed composite index for
// that combination, which was never created, so every call 500'd.
// Filtering on just `active` needs no composite index (single-field
// equality is auto-indexed); the newest one is picked in memory instead.
// The active-announcement list is the same for every caller, so it's
// cached for the same short shared window as the leaderboard above —
// only the per-user "have they already seen it" check below needs to
// be user-specific, and that already goes through getUserDoc().
router.get('/announcement', asyncHandler(async (req, res) => {
  const active = await announcementCache.get();
  if (active.length === 0) return res.json({ success: true, announcement: null });

  const ann = [...active].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];

  const userSnap = await getUserDoc(req.uid);
  const lastSeen = userSnap.exists ? userSnap.data.lastSeenAnnouncementId : null;
  if (lastSeen === ann.id) return res.json({ success: true, announcement: null });

  res.json({ success: true, announcement: { id: ann.id, message: ann.message, giftCode: ann.giftCode || null, giftAmount: ann.giftAmount || null } });
}));

// POST /api/user/announcement/seen — Body: { id }. Called once the popup
// has been shown (whether or not the gift was claimed) so it doesn't
// come back on the next login.
router.post('/announcement/seen', asyncHandler(async (req, res) => {
  const id = String(req.body?.id || '').trim();
  if (!id) return res.status(400).json({ success: false, error: 'Provide an announcement id' });
  await db().collection('users').doc(req.uid).set({ lastSeenAnnouncementId: id }, { merge: true });
  invalidateUserDoc(req.uid);
  res.json({ success: true });
}));

// ---------------------------------------------------------------
// Product feedback — real customer star ratings + comments, replacing
// the old hand-typed rating number in the catalog files. Only someone
// who's actually bought the product can review it (checked against
// their own purchaseHistory); one review per user per product, and
// resubmitting updates it rather than creating a duplicate.
// ---------------------------------------------------------------

// POST /api/user/feedback
// Body: { row, stars (1-5), comment?, authorName? }
router.post('/feedback', asyncHandler(async (req, res) => {
  const row = String(req.body?.row || '').trim();
  const stars = Number(req.body?.stars);
  const comment = String(req.body?.comment || '').trim().slice(0, 500);
  const authorName = String(req.body?.authorName || '').trim().slice(0, 60) || 'Anonymous';

  if (!row) return res.status(400).json({ success: false, error: 'Missing product' });
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    return res.status(400).json({ success: false, error: 'Rating must be 1-5 stars' });
  }

  const userSnap = await getUserDoc(req.uid);
  const purchaseHistory = userSnap.exists ? (userSnap.data.purchaseHistory || []) : [];

  // Verified-purchase check: a direct row match (purchases made after
  // this field was added) or a name match against the catalog's current
  // names for this row (covers purchases made before it existed).
  const catalog = await getLiveCatalog('user');
  const namesForRow = new Set(Object.values(catalog).filter((p) => p.row === row).map((p) => p.name));
  const verified = purchaseHistory.some((h) => h.row === row || namesForRow.has(h.name));
  if (!verified) {
    return res.status(403).json({ success: false, error: "You can only review products you've purchased" });
  }

  const id = `${req.uid}_${row}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
  const feedbackDoc = { uid: req.uid, authorName, row, stars, comment, createdAt: Date.now() };
  await db().collection('feedback').doc(id).set(feedbackDoc);

  recordFeedback(id, feedbackDoc); // patch just this review into the cache — no collection re-read
  res.json({ success: true });
}));

// GET /api/user/feedback?row=... — all feedback (optionally for one
// product), newest first. Powers /feedback.php.
router.get('/feedback', asyncHandler(async (req, res) => {
  const row = req.query.row ? String(req.query.row) : null;
  // Served from the in-memory feedback set (see src/catalog.js) — zero Firestore reads per call.
  res.json({ success: true, feedback: await getFeedbackList({ row, limit: 300 }) });
}));

// ---------------------------------------------------------------
// Reseller self-upgrade — once a regular user has bought/sold 8+ keys
// AND holds a balance of at least NRP 1500, they can promote themselves
// to 'reseller' from the dashboard. Both numbers are re-checked here
// against Firestore (never trusted from the client), so this can't be
// gamed by a frontend that lies about having met the requirement.
// ---------------------------------------------------------------
const RESELLER_MIN_KEYS = 8;
const RESELLER_MIN_BALANCE = 1500;

// POST /api/user/apply-reseller — no body needed; uid comes from the
// verified Firebase token. Promotes immediately on success (no separate
// admin approval step) since the two numeric gates ARE the approval —
// but still notifies Telegram so you have a record of every promotion.
router.post('/apply-reseller', asyncHandler(async (req, res) => {
  const userRef = db().collection('users').doc(req.uid);

  const result = await db().runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    const data = snap.exists ? snap.data() : {};

    if (isResellerTier(data.role || 'user')) {
      return { ok: false, error: 'You are already a reseller' };
    }

    const totalKeysBought = Number(data.totalKeysBought || 0);
    const balance = Number(data.balance || 0);

    if (totalKeysBought < RESELLER_MIN_KEYS || balance < RESELLER_MIN_BALANCE) {
      return {
        ok: false,
        error: `Not eligible yet — need ${RESELLER_MIN_KEYS}+ keys bought (you have ${totalKeysBought}) and NRP ${RESELLER_MIN_BALANCE}+ balance (you have NRP ${balance}).`,
      };
    }

    const log = data.adminLog || [];
    log.push({
      delta: 0,
      note: `Self-upgraded to reseller (${totalKeysBought} keys, NRP ${balance} balance)`,
      resultingBalance: balance,
      at: new Date().toISOString(),
    });

    tx.set(userRef, { role: 'reseller', adminLog: log }, { merge: true });
    return { ok: true, totalKeysBought, balance };
  });

  if (!result.ok) return res.status(400).json({ success: false, error: result.error });
  invalidateUserDoc(req.uid);

  telegramNotify(
    `👑 <b>RESELLER SELF-UPGRADE</b>\n` +
    `UID: <code>${esc(req.uid)}</code>\n` +
    `Email: ${esc(req.email)}\n` +
    `Keys bought: ${result.totalKeysBought}\n` +
    `Balance: NRP ${result.balance}`
  );

  res.json({ success: true, role: 'reseller' });
}));

// GET /api/user/reseller-progress — the two numbers the dashboard needs
// to draw the "X of 8 keys, NRP Y of 1500" progress bar, without the
// client ever computing eligibility itself (that stays server-side, see
// POST /apply-reseller above — this route is display-only).
router.get('/reseller-progress', asyncHandler(async (req, res) => {
  const snap = await getUserDoc(req.uid);
  const data = snap.exists ? snap.data : {};
  const totalKeysBought = Number(data.totalKeysBought || 0);
  const balance = Number(data.balance || 0);
  res.json({
    success: true,
    role: data.role || 'user',
    totalKeysBought,
    balance,
    minKeys: RESELLER_MIN_KEYS,
    minBalance: RESELLER_MIN_BALANCE,
    eligible: (data.role || 'user') === 'user' && totalKeysBought >= RESELLER_MIN_KEYS && balance >= RESELLER_MIN_BALANCE,
  });
}));

// ---------------------------------------------------------------
// PRO RESELLER — third mode (user -> reseller -> pro_reseller).
//
//  1. POST /pro-reseller/apply  { name, whatsapp, phone, tiktok }
//       (only allowed once the account is in RESELLER mode)
//       status 'pending'; the admin gets it in Telegram with
//       [ Approved ✅ ] [ CANCEL ❌ ] (src/proReseller.js).
//  2. Admin approves -> status 'approved'. Role and prices do NOT change yet.
//  3. The user makes a NEW top-up (old balance never counts). Once new top-ups
//     reach NRP PRO_MIN_TOPUP the role flips to 'pro_reseller' and the store
//     shows the pro prices (see depositUpdate() in src/proTier.js, called from
//     every top-up path: QR, admin panel, employee, Telegram /addbalance).
// ---------------------------------------------------------------
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);

router.post('/pro-reseller/apply', rateLimit({ windowMs: 10 * 60_000, max: 6, name: 'pro-apply' }), asyncHandler(async (req, res) => {
  const name = clean(req.body?.name, 60);
  const whatsapp = clean(req.body?.whatsapp, 20).replace(/[^\d+]/g, '');
  const phone = clean(req.body?.phone, 20).replace(/[^\d+]/g, '');
  const tiktok = clean(req.body?.tiktok, 40).replace(/^@+/, '');
  if (!name || !whatsapp || !phone || !tiktok) return res.status(400).json({ success: false, error: 'Please fill all 4 fields' });
  if (name.length < 2) return res.status(400).json({ success: false, error: 'Enter your full name' });
  if (whatsapp.replace(/\D/g, '').length < 7 || phone.replace(/\D/g, '').length < 7) {
    return res.status(400).json({ success: false, error: 'Enter valid WhatsApp business and phone numbers' });
  }
  if (!/^[A-Za-z0-9._]{2,40}$/.test(tiktok)) return res.status(400).json({ success: false, error: 'Enter your TikTok id (letters, numbers, . and _ only)' });

  const reqId = newProReqId();
  const userRef = db().collection('users').doc(req.uid);
  const idxRef = db().collection('proRequests').doc(reqId);
  const now = new Date().toISOString();

  let user;
  try {
    user = await db().runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      const d = snap.exists ? snap.data() : {};
      const pr = d.proReseller || {};
      if ((d.role || 'user') === 'pro_reseller' || pr.status === 'active') throw new Error('You are already a PRO RESELLER');
      // PRO RESELLER is only for accounts that already unlocked RESELLER mode.
      if ((d.role || 'user') !== 'reseller') throw new Error('Unlock RESELLER mode first, then you can send your details for PRO RESELLER approval');
      if (pr.status === 'pending') throw new Error('Your details are already being verified by admin');
      if (pr.status === 'approved') throw new Error('You are already approved — just top up to activate PRO RESELLER');
      tx.set(userRef, {
        proReseller: { status: 'pending', reqId, requestedAt: now, details: { name, whatsapp, phone, tiktok }, requiredDeposit: PRO_MIN_TOPUP, depositSinceApproval: 0 },
      }, { merge: true });
      tx.set(idxRef, { uid: req.uid, status: 'PENDING', createdAt: now, messages: [] });
      return d;
    });
  } catch (e) {
    return res.status(e.message.startsWith('Unlock RESELLER') ? 403 : 409).json({ success: false, error: e.message });
  }
  invalidateUserDoc(req.uid);

  // A Telegram outage must not fail the user's request: it stays 'pending' and
  // is also listed in the admin panel (GET /api/admin/pro-requests).
  try {
    const messages = await sendProRequestToBot(reqId, {
      storeName: user.profileName || '', email: user.email || req.email, uid: req.uid, name, whatsapp, phone, tiktok,
    });
    if (messages.length) await idxRef.set({ messages }, { merge: true });
  } catch (e) { console.warn('[pro-reseller] announce failed:', e?.name || 'error'); }

  res.json({ success: true, status: 'pending' });
}));

// GET /api/user/pro-reseller — current state (also included in /balance).
router.get('/pro-reseller', asyncHandler(async (req, res) => {
  const snap = await getUserDoc(req.uid);
  const d = snap.exists ? snap.data : {};
  res.json({ success: true, role: d.role || 'user', ...proPublicState(d) });
}));

// ---------------------------------------------------------------
// Profile picture. The browser crops/resizes the image into a square
// (the UI shows it as a circle), sends it here as base64, and THIS server
// uploads it to imgbb — so IMGBB_API_KEY never reaches the browser. Only the
// resulting URL is stored on the user doc (users/{uid}.avatarUrl).
// ---------------------------------------------------------------
const lastAvatarUpload = new Map(); // uid -> ms, basic per-user throttle
router.post('/avatar', asyncHandler(async (req, res) => {
  const now = Date.now();
  if (now - (lastAvatarUpload.get(req.uid) || 0) < 10_000) {
    return res.status(429).json({ success: false, error: 'Please wait a few seconds before uploading again.' });
  }

  // 1 photo change / 7 days — read fresh so a just-made change can't be bypassed via a cached copy.
  const userRef = db().collection('users').doc(req.uid);
  const cur = (await userRef.get()).data() || {};
  try { assertUnlocked(cur, 'avatar', now); }
  catch (e) { return res.status(e.status || 429).json({ success: false, error: e.message, ...(e.extra || {}) }); }

  lastAvatarUpload.set(req.uid, now);
  let url;
  try {
    url = await uploadAvatar(String(req.body?.image || ''), req.uid);
  } catch (e) {
    lastAvatarUpload.delete(req.uid);
    return res.status(e.status || 502).json({ success: false, error: e.message });
  }
  const stamps = { ...(cur.profileChangeAt || {}), avatar: Date.now() };
  await userRef.set({ avatarUrl: url, profileChangeAt: stamps }, { merge: true });
  invalidateUserDoc(req.uid);
  leaderboardCache.invalidate(); // the leaderboard row must show the new photo, not the old one
  res.json({ success: true, avatarUrl: url, locks: computeLocks({ profileChangeAt: stamps }) });
}));

router.delete('/avatar', asyncHandler(async (req, res) => {
  const now = Date.now();
  const userRef = db().collection('users').doc(req.uid);
  const cur = (await userRef.get()).data() || {};
  try { assertUnlocked(cur, 'avatar', now); }
  catch (e) { return res.status(e.status || 429).json({ success: false, error: e.message, ...(e.extra || {}) }); }
  const stamps = { ...(cur.profileChangeAt || {}), avatar: now };
  await userRef.set({ avatarUrl: '', profileChangeAt: stamps }, { merge: true });
  invalidateUserDoc(req.uid);
  leaderboardCache.invalidate();
  res.json({ success: true, avatarUrl: '', locks: computeLocks({ profileChangeAt: stamps }, now) });
}));

// GET /api/user/sync — "has anything changed?" Pure memory, ZERO Firestore reads.
// Browsers poll this every few seconds and refetch only the datasets whose stamp moved.
router.get('/sync', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, versions: getVersions(req.uid) });
});

// ---------------------------------------------------------------
// Policy acknowledgement — "Don't show again" has to be remembered
// server-side, tied to req.uid (verified by requireFirebaseUid), not
// localStorage: a localStorage flag only proves "this browser saw it
// once", which is fine for convenience but trivial to clear/fake and
// doesn't follow the account across devices. Storing it on the user's
// own Firestore doc means only that authenticated user can set their
// own flag (there's no uid parameter here to spoof — it's always
// req.uid), and dashboard.php re-checks this on every load rather than
// trusting any client-side cache of the answer.
// ---------------------------------------------------------------
router.get('/policy-ack', asyncHandler(async (req, res) => {
  const snap = await getUserDoc(req.uid);
  const data = snap.exists ? snap.data : {};
  res.json({ success: true, acknowledged: !!data.policyAcknowledged });
}));

router.post('/policy-ack', asyncHandler(async (req, res) => {
  await db().collection('users').doc(req.uid).set({
    policyAcknowledged: true,
    policyAcknowledgedAt: Date.now(),
  }, { merge: true });
  invalidateUserDoc(req.uid);
  res.json({ success: true });
}));

// ---------------------------------------------------------------
// Welcome popup ("watch the guide videos, then REDIRECT").
// The link is set by the admin (config/welcomePopup). The popup is shown to
// every account until it has been redirected ONCE — the flag lives on the
// user's own Firestore doc (always req.uid, nothing to spoof) so it follows
// the account, not the browser, and then the popup is off for that account.
// ---------------------------------------------------------------
router.get('/welcome-redirect', asyncHandler(async (req, res) => {
  const snap = await getUserDoc(req.uid);
  const data = snap.exists ? snap.data : {};
  if (data.welcomeRedirectDone) return res.json({ success: true, show: false });
  const cfg = await db().collection('config').doc('welcomePopup').get();
  const c = cfg.exists ? cfg.data() : {};
  const url = /^https?:\/\//i.test(String(c.url || '')) ? String(c.url) : '';
  // show = admin hasn't switched it off. url may be '' (no link saved) — the site then uses its default link.
  res.json({ success: true, show: c.enabled !== false, url });
}));

router.post('/welcome-redirect', asyncHandler(async (req, res) => {
  await db().collection('users').doc(req.uid).set({
    welcomeRedirectDone: true,
    welcomeRedirectAt: Date.now(),
  }, { merge: true });
  invalidateUserDoc(req.uid);
  res.json({ success: true });
}));

export default router;
