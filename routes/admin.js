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
    telegramNotify(telegramFormat(`Balance Load ${action === 'approve' ? 'Approved' : 'Rejected'}`, { username: uid, product: 'SRT X CHEATS (OWNER)', price: action === 'approve' ? amount : 0, uid, status: action === 'approve' ? 'success' : 'failed', others: `TX code: ${txCode}` }), 'balance');
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
}));

// ---------------------------------------------------------------
// Announcements — broadcast a popup to logged-in users.
// The user endpoint marks each announcement as seen per UID.
// ---------------------------------------------------------------

router.post('/announcements', asyncHandler(async (req, res) => {
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ success: false, error: 'Write a message first' });
  if (message.length > 2000) return res.status(400).json({ success: false, error: 'Announcement is too long' });

  let giftCode = null;
  let giftAmount = null;
  let giftMaxUses = null;

  if (req.body?.giftAmount !== undefined && req.body?.giftAmount !== null && String(req.body.giftAmount).trim() !== '') {
    giftAmount = Number(req.body.giftAmount);
    if (!Number.isInteger(giftAmount) || giftAmount <= 0) {
      return res.status(400).json({ success: false, error: 'Gift amount must be a positive whole number' });
    }

    const rawMax = req.body?.giftMaxUses;
    if (rawMax === undefined || rawMax === null || String(rawMax).trim() === '') {
      giftMaxUses = null;
    } else {
      giftMaxUses = Number(rawMax);
      if (!Number.isInteger(giftMaxUses) || giftMaxUses < 1 || giftMaxUses > 300) {
        return res.status(400).json({ success: false, error: 'Gift max uses must be between 1 and 300' });
      }
    }

    giftCode = generateRedeemCode();
    await db().collection('redeemCodes').doc(giftCode).set({
      code: giftCode,
      amount: giftAmount,
      maxUses: giftMaxUses,
      expiresAt: null,
      active: true,
      usedCount: 0,
      redeemedBy: [],
      createdAt: Date.now(),
      source: 'announcement',
    });
  }

  const ref = db().collection('announcements').doc();
  const announcement = {
    id: ref.id,
    message,
    giftCode,
    giftAmount,
    giftMaxUses,
    active: true,
    createdAt: Date.now(),
  };

  await ref.set(announcement);
  res.json({ success: true, announcement });
}));

router.get('/announcements', asyncHandler(async (req, res) => {
  const snap = await db().collection('announcements').orderBy('createdAt', 'desc').limit(100).get();
  res.json({
    success: true,
    announcements: snap.docs.map((d) => ({ id: d.id, ...d.data() })),
  });
}));

router.post('/announcements/:id/deactivate', asyncHandler(async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ success: false, error: 'Missing announcement id' });
  const ref = db().collection('announcements').doc(id);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ success: false, error: 'Announcement not found' });
  await ref.set({ active: false }, { merge: true });
  res.json({ success: true });
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
  // Groups of 5-6 random uppercase letters/digits, e.g. SRT_AB3F9-K72QRT-8ZXPL
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid confusion
  const group = (n) => Array.from({ length: n }, () => chars[crypto.randomInt(chars.length)]).join('');
  return `SRT_${group(5)}-${group(6)}-${group(5)}`;
}

// POST /api/admin/redeem-codes
// Body: { amount, maxUses (1-300, or null/omit for unlimited), expiresAt (ISO date string, or null/omit for unlimited), code (optional custom code) }
router.post('/redeem-codes', asyncHandler(async (req, res) => {
  const amount = Number(req.body?.amount);
  if (!amount || amount <= 0) return res.status(400).json({ success: false, error: 'Amount must be a positive number' });

  let maxUses = req.body?.maxUses;
  if (maxUses === '' || maxUses === undefined || maxUses === null || String(maxUses).toLowerCase() === 'unlimited') {
    maxUses = null;
  } else {
    maxUses = Number(maxUses);
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 300) {
      return res.status(400).json({ success: false, error: 'Max uses must be a whole number between 1 and 300, or unlimited' });
    }
  }

  let expiresAt = null;
  if (req.body?.expiresAt && String(req.body.expiresAt).toLowerCase() !== 'unlimited') {
    const t = new Date(req.body.expiresAt).getTime();
    if (Number.isNaN(t)) return res.status(400).json({ success: false, error: 'Invalid expiry date' });
    expiresAt = t;
  }

  const custom = String(req.body?.code || '').trim().toUpperCase();
  const code = custom || generateRedeemCode();
  const ref = db().collection('redeemCodes').doc(code);
  const existing = await ref.get();
  if (existing.exists) return res.status(409).json({ success: false, error: 'That code already exists' });

  await ref.set({
    code, amount, maxUses, expiresAt,
    active: true, usedCount: 0, redeemedBy: [],
    createdAt: Date.now(),
  });

  res.json({ success: true, code, amount, maxUses, expiresAt });
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

export default router;
