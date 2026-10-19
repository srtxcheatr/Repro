// src by SRT X CHEATS. Copy right SRT X CHEATS
import express from 'express';
import { newKeyFields } from '../src/rewards.js';
import crypto from 'crypto';
import admin from 'firebase-admin';
// src by SRT X CHEATS. Copy right SRT X CHEATS
import { asyncHandler } from '../src/asyncHandler.js';
import { db, requireFirebaseUid, userCors } from '../src/firebase.js';
import { catalogFind, getMaintenanceForSku, findCustomProductFresh } from '../src/srt_storage_product.js';
import { telegramNotify, telegramFormat } from '../src/telegram.js';
import { fetchRealKey } from '../src/upstream.js';
// src by SRT X CHEATS. Copy right SRT X CHEATS
import { invalidateUserDoc } from '../src/userCache.js';
import { leaderboardCache } from '../src/sharedCaches.js';

const router = express.Router();
router.use(userCors);
// src by SRT X CHEATS. Copy right SRT X CHEATS
router.use(requireFirebaseUid);

const jobs = new Map();
const JOB_TTL_MS = 3 * 60 * 1000;

// src by SRT X CHEATS. Copy right SRT X CHEATS
function setJob(jobId, patch) {
  const existing = jobs.get(jobId) || {};
  jobs.set(jobId, { ...existing, ...patch });
}

// src by SRT X CHEATS. Copy right SRT X CHEATS
router.post('/checkout/start', asyncHandler(async (req, res) => {
  const sku = String(req.body?.sku || '');
  const buyerName = String(req.body?.name || '').trim();
  const buyerWa = String(req.body?.waNum || '').trim();
  const androidId = req.body?.android_id ? String(req.body.android_id).trim() : null;
// src by SRT X CHEATS. Copy right SRT X CHEATS

  if (!sku) {
    return res.status(400).json({ success: false, error: 'Missing product selection. Please pick a duration and try again.' });
  }

  // src by SRT X CHEATS. Copy right SRT X CHEATS
  let product = catalogFind(sku);
  if (!product) {
    product = await findCustomProductFresh(sku);
  }
  if (!product) {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    return res.status(400).json({ success: false, error: 'Unknown product' });
  }

  const liveStatus = await getMaintenanceForSku(sku);
  if (product.maintenance || liveStatus.maintenance) {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    return res.status(409).json({
      success: false,
      error: liveStatus.maintenanceMessage || product.maintenanceMessage || 'This product is currently under maintenance.',
    });
  }
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (product.outOfStock || liveStatus.outOfStock) {
    return res.status(409).json({
      success: false,
      error: liveStatus.outOfStockMessage || product.outOfStockMessage || 'This duration is currently out of stock.',
    });
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  }
  if (product.type === 'manual') {
    return res.status(400).json({ success: false, error: 'This product is ordered via WhatsApp, not instant checkout.' });
  }

  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (product.requiresAndroidId && !androidId) {
    return res.status(400).json({ success: false, error: 'Android ID is required for this product' });
  }

  {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    const userSnap = await db().collection('users').doc(req.uid).get();
    const userData = userSnap.exists ? userSnap.data() : {};
    const role = userData.role || 'user';
    const balance = Number(userData.balance || 0);

    // src by SRT X CHEATS. Copy right SRT X CHEATS
    const bannedUntil = Number(userData.checkoutBanUntil || 0);
    if (bannedUntil > Date.now()) {
      return res.status(403).json({
        success: false,
        code: 'CHECKOUT_BANNED',
        // src by SRT X CHEATS. Copy right SRT X CHEATS
        error: 'Too many purchase attempts with insufficient balance. Please wait before trying again.',
        bannedUntil,
      });
    }

    // src by SRT X CHEATS. Copy right SRT X CHEATS
    let roleProduct = catalogFind(sku, role) || await findCustomProductFresh(sku, role) || product;
    const realPrice = Number(roleProduct.price);

    if (balance < realPrice) {
      const strikes = Number(userData.lowBalanceStrikes || 0) + 1;
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      const updates = { lowBalanceStrikes: strikes };

      let justBanned = false;
      if (strikes >= 2) {
        updates.checkoutBanUntil = Date.now() + 60 * 60 * 1000;
        // src by SRT X CHEATS. Copy right SRT X CHEATS
        updates.lowBalanceStrikes = 0;
        justBanned = true;
      }
      await db().collection('users').doc(req.uid).set(updates, { merge: true });
      invalidateUserDoc(req.uid, { history: false });
// src by SRT X CHEATS. Copy right SRT X CHEATS

      if (justBanned) {
        telegramNotify(telegramFormat('Checkout Banned (1h)', {
          username: userData.profileName || req.email, email: userData.email || req.email,
          phone: userData.profilePhone || '', product: roleProduct.name || sku,
          // src by SRT X CHEATS. Copy right SRT X CHEATS
          price: realPrice, uid: req.uid, status: 'failed',
          others: `2nd insufficient-balance attempt — banned until ${new Date(updates.checkoutBanUntil).toISOString()} (role: ${role})`,
        }));
        return res.status(403).json({
          success: false,
          // src by SRT X CHEATS. Copy right SRT X CHEATS
          code: 'CHECKOUT_BANNED',
          error: 'Too many purchase attempts with insufficient balance. Please wait before trying again.',
          bannedUntil: updates.checkoutBanUntil,
        });
      }
// src by SRT X CHEATS. Copy right SRT X CHEATS

      return res.status(402).json({
        success: false,
        code: 'INSUFFICIENT_BALANCE',
        error: "You have 0 balance and can't purchase any product. Please top up first then try again.",
        // src by SRT X CHEATS. Copy right SRT X CHEATS
        balance, required: realPrice,
      });
    }

    if (Number(userData.lowBalanceStrikes || 0) > 0) {
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      await db().collection('users').doc(req.uid).set({ lowBalanceStrikes: 0 }, { merge: true });
      invalidateUserDoc(req.uid, { history: false });
    }
  }

  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const jobId = crypto.randomUUID();
  setJob(jobId, {
    uid: req.uid,
    percent: 0,
    label: 'Queued...',
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    done: false,
    createdAt: Date.now(),
    androidId,
  });
  setTimeout(() => jobs.delete(jobId), JOB_TTL_MS);
// src by SRT X CHEATS. Copy right SRT X CHEATS

  res.json({ success: true, jobId });

  runCheckoutJob(jobId, req.uid, req.email, sku, buyerName, buyerWa, androidId);
}));
// src by SRT X CHEATS. Copy right SRT X CHEATS

router.get('/checkout/status/:jobId', asyncHandler(async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ success: false, error: 'Job not found or expired', done: true });
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  }
  if (job.uid !== req.uid) {
    return res.status(403).json({ success: false, error: 'Not your job', done: true });
  }
  res.json({
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    percent: job.percent,
    label: job.label,
    done: job.done,
    success: job.success ?? null,
    key: job.key,
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    newBalance: job.newBalance,
    entry: job.entry,
    error: job.error,
  });
}));
// src by SRT X CHEATS. Copy right SRT X CHEATS

async function runCheckoutJob(jobId, uid, email, sku, buyerName, buyerWa, androidId) {
  const userRef = db().collection('users').doc(uid);

  setJob(jobId, { percent: 5, label: 'Checking request...' });
// src by SRT X CHEATS. Copy right SRT X CHEATS

  let role = 'user';
  let product = null;
  let realPrice = 0;

  // src by SRT X CHEATS. Copy right SRT X CHEATS
  try {
    const roleSnap = await userRef.get();
    role = roleSnap.exists ? (roleSnap.data().role || 'user') : 'user';
    product = catalogFind(sku, role);
    if (!product) {
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      product = await findCustomProductFresh(sku, role);
    }
    if (!product) {
      throw new Error('Unknown product');
    }
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    realPrice = Number(product.price);

    const liveStatus = await getMaintenanceForSku(sku);
    if (product.maintenance || liveStatus.maintenance) {
      throw new Error(liveStatus.maintenanceMessage || product.maintenanceMessage || 'This product is currently under maintenance.');
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    }
    if (product.outOfStock || liveStatus.outOfStock) {
      throw new Error(liveStatus.outOfStockMessage || product.outOfStockMessage || 'This duration is currently out of stock.');
    }
    if (product.type === 'manual') {
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      throw new Error('This product is ordered via WhatsApp, not instant checkout.');
    }

    if (product.requiresAndroidId && !androidId) {
      throw new Error('Android ID is required for this product');
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    }

    setJob(jobId, { percent: 20, label: 'Checking product...' });

    telegramNotify(telegramFormat('Purchase attempt', {
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      username: buyerName || email, email, phone: buyerWa, product: product.name,
      duration: product.duration, price: realPrice, uid, status: 'attempt',
      others: `role: ${role}`,
    }));

    // src by SRT X CHEATS. Copy right SRT X CHEATS
    setJob(jobId, { percent: 35, label: 'Checking balance...' });

    const result = await db().runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      const currentBalance = snap.exists ? Number(snap.data().balance || 0) : 0;
// src by SRT X CHEATS. Copy right SRT X CHEATS

      if (currentBalance < realPrice) {
        throw new Error('Please top up first then trying 🙏');
      }

      // src by SRT X CHEATS. Copy right SRT X CHEATS
      setJob(jobId, { percent: 55, label: 'Connecting to server...' });
      const key = await fetchRealKey(sku, product, androidId);
      setJob(jobId, { percent: 80, label: 'Server connected...' });

      setJob(jobId, { percent: 90, label: 'Finalizing order...' });
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      const newBalance = currentBalance - realPrice;
      const historyEntry = {
        at: new Date().toISOString(), sku, row: product.row, name: product.name, duration: product.duration,
        price: realPrice, key, buyerName, buyerWa,
      };
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      const purchaseHistory = snap.exists ? (snap.data().purchaseHistory || []) : [];
      purchaseHistory.push(historyEntry);

      tx.set(userRef, {
        balance: newBalance, purchaseHistory,
        // src by SRT X CHEATS. Copy right SRT X CHEATS
        totalKeysBought: admin.firestore.FieldValue.increment(1),
        totalSpent: admin.firestore.FieldValue.increment(realPrice),
        ...newKeyFields(1),
      }, { merge: true });
      return { key, newBalance, currentBalance, entry: historyEntry };
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    });
    invalidateUserDoc(uid);
    leaderboardCache.invalidate();

    setJob(jobId, { percent: 100, label: 'Delivered!', done: true, success: true, key: result.key, newBalance: result.newBalance, entry: result.entry });
// src by SRT X CHEATS. Copy right SRT X CHEATS

    telegramNotify(telegramFormat('Purchase success', {
      username: buyerName || email, email, phone: buyerWa, product: product.name,
      duration: product.duration, price: realPrice, key: result.key, uid, status: 'success',
      balanceBefore: result.currentBalance, balanceAfter: result.newBalance,
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    }));
  } catch (e) {
    setJob(jobId, { percent: 100, done: true, success: false, error: e.message, label: 'Failed' });

    telegramNotify(telegramFormat('Purchase rejected', {
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      username: buyerName || email, email, phone: buyerWa, product: product ? product.name : sku,
      duration: product ? product.duration : '', price: realPrice, uid, status: 'failed',
      others: `${e.message} (role: ${role})`,
    }));
  }
// src by SRT X CHEATS. Copy right SRT X CHEATS
}

export default router;
