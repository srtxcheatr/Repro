import express from 'express';
import admin from 'firebase-admin';
import { asyncHandler } from '../src/asyncHandler.js';
import { db, requireFirebaseUid, userCors } from '../src/firebase.js';
import { telegramNotify, telegramFormat, esc } from '../src/telegram.js';
import { getLiveCatalog } from '../src/catalog.js';

const router = express.Router();
router.use(userCors);
router.use(requireFirebaseUid);

const DEFAULTS = (email) => ({
  email,
  role: 'user', // 'user' (retail catalog) or 'reseller' (reseller catalog) - admin-only to change
  profileName: '',
  profilePhone: '',
  tiktok: '',
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
  const tiktok = String(req.body?.tiktok || '').trim();

  const userRef = db().collection('users').doc(req.uid);
  const snap = await userRef.get();

  if (!snap.exists) {
    const data = DEFAULTS(req.email);
    if (name) data.profileName = name;
    if (phone) data.profilePhone = phone;
    if (tiktok) data.tiktok = tiktok;
    await userRef.set(data, { merge: true });
  } else {
    const patch = {};
    if (req.email && snap.data().email !== req.email) patch.email = req.email;
    // Only fill in fields that are still blank — never clobber values
    // the user already saved from their profile page.
    if (name && !snap.data().profileName) patch.profileName = name;
    if (phone && !snap.data().profilePhone) patch.profilePhone = phone;
    if (tiktok && !snap.data().tiktok) patch.tiktok = tiktok;
    if (Object.keys(patch).length) await userRef.set(patch, { merge: true });
  }
  res.json({ success: true });
}));

// GET /api/user/balance — the single state call the frontend polls.
router.get('/balance', asyncHandler(async (req, res) => {
  const userRef = db().collection('users').doc(req.uid);
  const snap = await userRef.get();

  let data;
  if (!snap.exists) {
    data = DEFAULTS(req.email);
    await userRef.set(data, { merge: true });
  } else {
    data = snap.data();
  }

  res.json({
    success: true,
    balance: Number(data.balance || 0),
    adminMessage: data.adminMessage || '',
    requestStatus: data.requestStatus || 'Active',
    profileName: data.profileName || '',
    profilePhone: data.profilePhone || '',
    tiktok: data.tiktok || '',
    email: data.email || req.email,
    role: data.role || 'user',
    totalKeysBought: Number(data.totalKeysBought || 0),
    totalSpent: Number(data.totalSpent || 0),
    hasCompletedFirstTopup: (data.topupRequests || []).some((t) => t.status === 'APPROVED'),
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
  const snap = await db().collection('users').doc(req.uid).get();
  const role = snap.exists ? (snap.data().role || 'user') : 'user';
  res.json({ success: true, role, catalog: await getLiveCatalog(role) });
}));

// POST /api/user/profile
router.post('/profile', asyncHandler(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const phone = String(req.body?.phone || '').trim();
  const tiktok = String(req.body?.tiktok ?? '').trim();
  if (!name || !phone) {
    return res.status(400).json({ success: false, error: 'Please fill both fields' });
  }
  if (name.length > 60 || phone.length > 30) {
    return res.status(400).json({ success: false, error: 'Name or phone is too long' });
  }
  if (tiktok.length > 200) {
    return res.status(400).json({ success: false, error: 'TikTok link is too long' });
  }
  const update = {
    profileName: name, profilePhone: phone, name, whatsapp: phone, email: req.email,
  };
  // tiktok is optional — only touch it when the caller actually sent
  // the field, so a bare {name, phone} save (e.g. from the "complete
  // your profile" popup) doesn't wipe out a tiktok link saved earlier.
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'tiktok')) {
    update.tiktok = tiktok;
  }
  await db().collection('users').doc(req.uid).set(update, { merge: true });
  res.json({ success: true });
}));

// GET /api/user/history
router.get('/history', asyncHandler(async (req, res) => {
  const snap = await db().collection('users').doc(req.uid).get();
  const purchases = snap.exists ? (snap.data().purchaseHistory || []) : [];
  res.json({ success: true, history: [...purchases].reverse() });
}));

// POST /api/user/history-clear
router.post('/history-clear', asyncHandler(async (req, res) => {
  await db().collection('users').doc(req.uid).set({ purchaseHistory: [] }, { merge: true });
  res.json({ success: true });
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
    const profileSnap = await userRef.get();
    const profile = profileSnap.exists ? profileSnap.data() : {};
    const notifyText = telegramFormat('Balance Load Request',{
      username: profile.profileName || req.email,
      email: profile.email || req.email,
      product: paymentAccount,
      price: amount,
      uid: req.uid,
      status:'pending',
      others:`TX code: ${txCode}\nNumber: ${profile.profilePhone || '—'}`
    });
    await telegramNotify(notifyText,'balance');
    return res.json({success:true,request:entry});
  } catch(e) { res.status(409).json({success:false,error:e.message}); }
}));

// GET /api/user/balance-history — the user's own deposit/adjustment
// log (top-up approvals, admin corrections). Different from
// /history, which is what they bought, not what was added to balance.
router.get('/balance-history', asyncHandler(async (req, res) => {
  const snap = await db().collection('users').doc(req.uid).get();
  const log = snap.exists ? (snap.data().adminLog || []) : [];
  res.json({ success: true, log: [...log].reverse() });
}));

// POST /api/user/report { category, problem }
router.post('/report', asyncHandler(async(req,res)=>{
  const category=String(req.body?.category||'').trim(); const problem=String(req.body?.problem||'').trim();
  if(!['Balance','Unknown product','Others'].includes(category)) return res.status(400).json({success:false,error:'Choose a valid bug category'});
  if(!problem) return res.status(400).json({success:false,error:'Please describe the problem'});
  if(problem.length>1000) return res.status(400).json({success:false,error:'Please keep it under 1000 characters'});
  const snap=await db().collection('users').doc(req.uid).get(); const data=snap.exists?snap.data():{};
  telegramNotify(`🐛 <b>BUG REPORT</b>\n📌 Category: <b>${esc(category)}</b>\n👤 ${esc(data.profileName||'—')}\n✉️ ${esc(data.email||req.email)}\n📱 ${esc(data.profilePhone||'—')}\n💰 Rs ${esc(data.balance??0)}\n🆔 <code>${esc(req.uid)}</code>\n🌐 IP: <code>${esc(req.ip)}</code>\n📅 ${esc(new Date().toISOString())}\n📝 ${esc(problem)}`,'bug');
  res.json({success:true});
}));

// GET /api/user/leaderboard — top 10 users by lifetime keys bought.
// Only ever exposes name + counts, never email/phone/balance, since
// every logged-in user can see this list.
router.get('/leaderboard', asyncHandler(async (req, res) => {
  const snap = await db().collection('users')
    .orderBy('totalKeysBought', 'desc')
    .limit(10)
    .get();

  const board = snap.docs
    .map((doc) => {
      const d = doc.data();
      return {
        uid: doc.id,
        name: d.profileName || (d.email ? d.email.split('@')[0] : 'Anonymous'),
        totalKeysBought: Number(d.totalKeysBought || 0),
        totalSpent: Number(d.totalSpent || 0),
      };
    })
    .filter((row) => row.totalKeysBought > 0);

  res.json({ success: true, leaderboard: board });
}));

// GET /api/user/public-profile?uid=... — the "view profile" card any
// logged-in user can open from the leaderboard. Shows this platform's
// own account fields (name/email/phone/tiktok/stats) — not sensitive
// admin data like balance, adminLog or full purchase history.
router.get('/public-profile', asyncHandler(async (req, res) => {
  const uid = String(req.query.uid || '').trim();
  if (!uid) return res.status(400).json({ success: false, error: 'Provide a uid' });

  const snap = await db().collection('users').doc(uid).get();
  if (!snap.exists) return res.status(404).json({ success: false, error: 'User not found' });

  const d = snap.data();
  res.json({
    success: true,
    uid,
    name: d.profileName || (d.email ? d.email.split('@')[0] : 'Anonymous'),
    email: d.email || '',
    phone: d.profilePhone || '',
    tiktok: d.tiktok || '',
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
router.get('/announcement', asyncHandler(async (req, res) => {
  const annSnap = await db().collection('announcements')
    .where('active', '==', true)
    .limit(20)
    .get();
  if (annSnap.empty) return res.json({ success: true, announcement: null });

  const ann = annSnap.docs
    .map((d) => d.data())
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];

  const userSnap = await db().collection('users').doc(req.uid).get();
  const lastSeen = userSnap.exists ? userSnap.data().lastSeenAnnouncementId : null;
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
  res.json({ success: true });
}));

export default router;
