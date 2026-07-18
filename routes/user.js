import express from 'express';
import crypto from 'crypto';
import { asyncHandler } from '../src/asyncHandler.js';
import { db, requireFirebaseUid, userCors } from '../src/firebase.js';

const router = express.Router();
router.use(userCors);
router.use(requireFirebaseUid);

const DEFAULTS = (email) => ({
  email,
  profileName: '',
  profilePhone: '',
  requestStatus: 'Active',
  adminMessage: 'Welcome! Pay via eSewa or Balance to get your key 🔑',
  balance: 0,
  purchaseHistory: [],
  apiKeys: [],
});

// POST /api/user/init — called once right after signup/Google sign-in.
router.post('/init', asyncHandler(async (req, res) => {
  const userRef = db().collection('users').doc(req.uid);
  const snap = await userRef.get();

  if (!snap.exists) {
    await userRef.set(DEFAULTS(req.email), { merge: true });
  } else if (req.email && snap.data().email !== req.email) {
    await userRef.set({ email: req.email }, { merge: true });
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
    email: data.email || req.email,
  });
}));

// POST /api/user/profile
router.post('/profile', asyncHandler(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const phone = String(req.body?.phone || '').trim();
  if (!name || !phone) {
    return res.status(400).json({ success: false, error: 'Please fill both fields' });
  }
  if (name.length > 60 || phone.length > 30) {
    return res.status(400).json({ success: false, error: 'Name or phone is too long' });
  }
  await db().collection('users').doc(req.uid).set({
    profileName: name, profilePhone: phone, name, whatsapp: phone, email: req.email,
  }, { merge: true });
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

// POST /api/user/topup
router.post('/topup', asyncHandler(async (req, res) => {
  const amount = parseInt(req.body?.amount, 10);
  const esewaId = String(req.body?.esewaId || '').trim();
  const txCode = String(req.body?.txCode || '').trim().toUpperCase();

  if (!amount || amount < 50) return res.status(400).json({ success: false, error: 'Enter a valid amount' });
  if (!esewaId || !txCode) return res.status(400).json({ success: false, error: 'eSewa ID and transaction code are required' });

  const userRef = db().collection('users').doc(req.uid);
  try {
    const entry = await db().runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      const existing = snap.exists ? (snap.data().topupRequests || []) : [];
      if (existing.some((t) => String(t.txCode).toUpperCase() === txCode)) {
        throw new Error('This transaction ID was already submitted');
      }
      const e = {
        date: new Date().toISOString(), amount, esewaId, txCode,
        status: 'PENDING', uid: req.uid, email: req.email,
      };
      tx.set(userRef, { topupRequests: [...existing, e] }, { merge: true });
      return e;
    });
    res.json({ success: true, request: entry });
  } catch (e) {
    res.status(409).json({ success: false, error: e.message });
  }
}));

// GET /api/user/keys
router.get('/keys', asyncHandler(async (req, res) => {
  const snap = await db().collection('users').doc(req.uid).get();
  res.json({ success: true, apiKeys: snap.exists ? (snap.data().apiKeys || []) : [] });
}));

// POST /api/user/keys  { action: "generate" | "revoke" | "delete", key? }
router.post('/keys', asyncHandler(async (req, res) => {
  const action = String(req.body?.action || '');
  const userRef = db().collection('users').doc(req.uid);

  if (action === 'generate') {
    try {
      const keys = await db().runTransaction(async (tx) => {
        const snap = await tx.get(userRef);
        const existing = snap.exists ? (snap.data().apiKeys || []) : [];
        const activeCount = existing.filter((k) => k.active).length;
        if (activeCount >= 3) throw new Error('Max 3 active keys allowed. Revoke one first.');

        const newKey = {
          key: 'srtx_' + crypto.randomBytes(20).toString('hex'),
          createdAt: new Date().toISOString(),
          active: true,
        };
        const updated = [...existing, newKey];
        tx.set(userRef, { apiKeys: updated }, { merge: true });
        return updated;
      });
      return res.json({ success: true, apiKeys: keys });
    } catch (e) {
      return res.status(400).json({ success: false, error: e.message });
    }
  }

  if (action === 'revoke' || action === 'delete') {
    const keyStr = String(req.body?.key || '');
    if (!keyStr) return res.status(400).json({ success: false, error: 'Missing key' });

    const keys = await db().runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      const existing = snap.exists ? (snap.data().apiKeys || []) : [];
      const updated = action === 'revoke'
        ? existing.map((k) => (k.key === keyStr ? { ...k, active: false } : k))
        : existing.filter((k) => k.key !== keyStr);
      tx.set(userRef, { apiKeys: updated }, { merge: true });
      return updated;
    });
    return res.json({ success: true, apiKeys: keys });
  }

  res.status(400).json({ success: false, error: 'Unknown action' });
}));

export default router;
