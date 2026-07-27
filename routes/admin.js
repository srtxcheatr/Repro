import express from 'express';
import { asyncHandler } from '../src/asyncHandler.js';
import { db, requireAdmin, adminCors } from '../src/firebase.js';

const router = express.Router();
router.use(adminCors);
router.use(requireAdmin);

const EMPTY_USER = (uid, email = '') => ({
  success: true, uid, found: false,
  balance: 0, email, adminLog: [], purchases: [],
  topupRequests: [], requestStatus: 'Active', adminMessage: '',
  profileName: '', profilePhone: '',
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
  });
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
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
}));

export default router;
