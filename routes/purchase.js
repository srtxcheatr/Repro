import express from 'express';
import crypto from 'crypto';
import { asyncHandler } from '../src/asyncHandler.js';
import { db, requireFirebaseUid, userCors } from '../src/firebase.js';
import { catalogFind } from '../src/catalog.js';
import { telegramNotify, telegramFormat } from '../src/telegram.js';

const router = express.Router();
router.use(userCors);
router.use(requireFirebaseUid);

/**
 * STUB — not implemented here.
 *
 * Plug in your actual reseller/key-fetch call. It receives the sku
 * and the full catalog entry (pid, row, name, duration, price), and
 * must either return the key string on success or throw on failure
 * (which cancels the whole transaction — no balance gets deducted,
 * no history entry gets written).
 */
async function fetchRealKey(sku, product) {
  throw new Error('fetchRealKey() is not implemented — plug in your reseller call here.');
}

// ---- In-memory job tracker ----
// A single Render instance, low-traffic solo store — this is fine.
// If this backend ever runs multiple instances, jobs would need to
// move to Firestore/Redis instead, since each instance would have
// its own separate Map.
const jobs = new Map();
const JOB_TTL_MS = 3 * 60 * 1000; // jobs are cleaned up 3 min after creation

function setJob(jobId, patch) {
  const existing = jobs.get(jobId) || {};
  jobs.set(jobId, { ...existing, ...patch });
}

// POST /api/purchase/checkout/start — kicks off the job, returns
// immediately with a jobId. The actual work happens in the
// background function below; the frontend polls status separately.
router.post('/checkout/start', asyncHandler(async (req, res) => {
  const sku = String(req.body?.sku || '');
  const buyerName = String(req.body?.name || '').trim();
  const buyerWa = String(req.body?.waNum || '').trim();

  const product = catalogFind(sku);
  if (!product) {
    return res.status(400).json({ success: false, error: 'Unknown product' });
  }

  const jobId = crypto.randomUUID();
  setJob(jobId, {
    uid: req.uid, percent: 0, label: 'Queued...', done: false,
    createdAt: Date.now(),
  });
  setTimeout(() => jobs.delete(jobId), JOB_TTL_MS);

  res.json({ success: true, jobId });

  // Fire-and-forget — runs after the response above is already sent.
  runCheckoutJob(jobId, req.uid, req.email, sku, product, buyerName, buyerWa);
}));

// GET /api/purchase/checkout/status/:jobId
router.get('/checkout/status/:jobId', asyncHandler(async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ success: false, error: 'Job not found or expired', done: true });
  }
  if (job.uid !== req.uid) {
    return res.status(403).json({ success: false, error: 'Not your job', done: true });
  }
  res.json({
    percent: job.percent,
    label: job.label,
    done: job.done,
    success: job.success ?? null,
    key: job.key,
    newBalance: job.newBalance,
    error: job.error,
  });
}));

async function runCheckoutJob(jobId, uid, email, sku, product, buyerName, buyerWa) {
  const realPrice = Number(product.price);
  const userRef = db().collection('users').doc(uid);

  setJob(jobId, { percent: 10, label: 'Verifying product...' });
  telegramNotify(telegramFormat('Purchase attempt', {
    username: buyerName || email, email, product: product.name,
    duration: product.duration, price: realPrice, uid, status: 'attempt',
  }));

  try {
    setJob(jobId, { percent: 30, label: 'Checking balance...' });

    const result = await db().runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      const currentBalance = snap.exists ? Number(snap.data().balance || 0) : 0;

      if (currentBalance < realPrice) {
        throw new Error('Insufficient balance');
      }

      setJob(jobId, { percent: 60, label: 'Contacting reseller...' });
      const key = await fetchRealKey(sku, product);

      setJob(jobId, { percent: 90, label: 'Finalizing order...' });
      const newBalance = currentBalance - realPrice;
      const historyEntry = {
        at: new Date().toISOString(), name: product.name, duration: product.duration,
        price: realPrice, key, buyerName, buyerWa,
      };
      const purchaseHistory = snap.exists ? (snap.data().purchaseHistory || []) : [];
      purchaseHistory.push(historyEntry);

      tx.set(userRef, { balance: newBalance, purchaseHistory }, { merge: true });
      return { key, newBalance };
    });

    setJob(jobId, { percent: 100, label: 'Delivered!', done: true, success: true, ...result });

    telegramNotify(telegramFormat('Purchase success', {
      username: buyerName || email, email, product: product.name,
      duration: product.duration, price: realPrice, key: result.key, uid, status: 'success',
    }));
  } catch (e) {
    setJob(jobId, { percent: 100, done: true, success: false, error: e.message, label: 'Failed' });

    telegramNotify(telegramFormat('Purchase rejected', {
      username: buyerName || email, email, product: product.name,
      duration: product.duration, price: realPrice, uid, status: 'failed', others: e.message,
    }));
  }
}

export default router;
