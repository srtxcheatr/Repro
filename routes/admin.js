import express from 'express';
import crypto from 'crypto';
import { asyncHandler } from '../src/asyncHandler.js';
import { db, requireAdmin, adminCors } from '../src/firebase.js';
import { telegramNotify, telegramFormat } from '../src/telegram.js';

const router = express.Router();
router.use(adminCors);
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
