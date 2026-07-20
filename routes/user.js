import express from 'express';
import { asyncHandler } from '../src/asyncHandler.js';
import { db, requireFirebaseUid, userCors } from '../src/firebase.js';
import { telegramNotify, telegramFormat, esc } from '../src/telegram.js';

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
    hasCompletedFirstTopup: (data.topupRequests || []).some((t) => t.status === 'APPROVED'),
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

      // First-time top-up is locked at exactly Rs 1000 — enforced
      // here, not just in the UI, since a UI-only lock is trivially
      // bypassed by editing the request (same lesson as everything
      // else in this backend).
      const hasCompletedFirstTopup = existing.some((t) => t.status === 'APPROVED');
      if (!hasCompletedFirstTopup && amount !== 1000) {
        throw new Error('Your first top-up must be exactly Rs 1000');
      }

      const e = {
        date: new Date().toISOString(), amount, esewaId, txCode,
        status: 'PENDING', uid: req.uid, email: req.email,
      };
      tx.set(userRef, { topupRequests: [...existing, e] }, { merge: true });
      return e;
    });
    res.json({ success: true, request: entry });

    telegramNotify(telegramFormat('Top-up request', {
      username: req.email, email: req.email, product: `eSewa top-up (${esewaId})`,
      price: amount, uid: req.uid, status: 'pending', others: `txCode: ${txCode}`,
    }));
  } catch (e) {
    res.status(409).json({ success: false, error: e.message });
  }
}));

// GET /api/user/balance-history — the user's own deposit/adjustment
// log (top-up approvals, admin corrections). Different from
// /history, which is what they bought, not what was added to balance.
router.get('/balance-history', asyncHandler(async (req, res) => {
  const snap = await db().collection('users').doc(req.uid).get();
  const log = snap.exists ? (snap.data().adminLog || []) : [];
  res.json({ success: true, log: [...log].reverse() });
}));

// POST /api/user/report — "Report a Problem" form. Notifies you on
// Telegram with full context so you don't have to ask the user for
// their UID/balance/etc. — it's all pulled server-side from their
// actual account, not from anything the client claims.
router.post('/report', asyncHandler(async (req, res) => {
  const problem = String(req.body?.problem || '').trim();
  if (!problem) {
    return res.status(400).json({ success: false, error: 'Please describe the problem' });
  }
  if (problem.length > 1000) {
    return res.status(400).json({ success: false, error: 'Please keep it under 1000 characters' });
  }

  const snap = await db().collection('users').doc(req.uid).get();
  const data = snap.exists ? snap.data() : {};

  telegramNotify(
    `🐛 <b>Problem Report</b>\n` +
    `👤 ${esc(data.profileName || '—')}\n` +
    `✉️ ${esc(data.email || req.email)}\n` +
    `📱 ${esc(data.profilePhone || '—')}\n` +
    `💰 Rs ${esc(data.balance ?? 0)}\n` +
    `🆔 <code>${esc(req.uid)}</code>\n` +
    `🌐 IP: <code>${esc(req.ip)}</code>\n` +
    `📅 ${esc(new Date().toISOString())}\n` +
    `📝 ${esc(problem)}`
  );

  res.json({ success: true });
}));

export default router;
