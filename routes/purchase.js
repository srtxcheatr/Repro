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
 * Fetch a real product key from the reseller API.
 * Uses environment variables:
 *   RESELLER_API_KEY      – your API key
 *   RESELLER_MASTER_KEY   – master key for the x‑master‑key header
 *   RESELLER_ENDPOINT     – (optional) API URL, defaults to https://xyzcheats.com/api/reseller_v1.php
 */
async function fetchRealKey(sku, product) {
  // ---- Load credentials from environment ----
  const API_KEY = process.env.RESELLER_API_KEY;
  const MASTER_KEY = process.env.RESELLER_MASTER_KEY;
  const API_URL = process.env.RESELLER_ENDPOINT || 'https://xyzcheats.com/api/reseller_v1.php';

  if (!API_KEY) {
    throw new Error('Reseller API key not configured (RESELLER_API_KEY missing)');
  }
  if (!MASTER_KEY) {
    throw new Error('Reseller master key not configured (RESELLER_MASTER_KEY missing)');
  }

  // ---- Build form data ----
  const formData = new URLSearchParams();
  formData.append('api_key', API_KEY);
  formData.append('action', 'buy');
  formData.append('product_id', product.pid);
  formData.append('duration', product.duration);

  console.log(`[Reseller] Requesting key for pid=${product.pid}, duration=${product.duration}`);

  // ---- Make request ----
  let response;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'x-master-key': MASTER_KEY,
      },
      body: formData.toString(),
      signal: AbortSignal.timeout(15000), // 15 seconds
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Reseller API request timed out. Please try again.');
    }
    throw new Error(`Failed to connect to reseller API: ${err.message}`);
  }

  // ---- Read raw response ----
  const text = await response.text();
  console.log('[Reseller] Raw response:', text);

  // ---- Try to parse JSON ----
  let data;
  try {
    data = JSON.parse(text);
    console.log('[Reseller] Parsed JSON:', JSON.stringify(data, null, 2));
  } catch (_) {
    // Not JSON – treat as plain text (maybe a key)
    if (text.trim().length > 0 && text.trim().length < 100) {
      return text.trim(); // likely a key
    }
    throw new Error(`Reseller API returned invalid response: ${text.slice(0, 200)}`);
  }

  // ---- Check HTTP status ----
  if (!response.ok) {
    const msg = data?.message || data?.error || `HTTP ${response.status}`;
    throw new Error(`Reseller API error: ${msg}`);
  }

  // ---- Check explicit failure flag ----
  if (data.success === false) {
    throw new Error(data.message || 'Reseller API reported failure');
  }

  // ---- Extract key from various structures ----
  const key =
    data.key ||
    (data.data && data.data.key) ||
    (data.result && data.result.key) ||
    (typeof data === 'string' ? data : null);

  if (!key) {
    console.error('[Reseller] No key in response:', JSON.stringify(data));
    throw new Error('Reseller API returned no key. Please contact support.');
  }

  console.log('[Reseller] Key fetched successfully');
  return key;
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
  runCheckoutJob(jobId, req.uid, req.email, sku, buyerName, buyerWa);
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

async function runCheckoutJob(jobId, uid, email, sku, buyerName, buyerWa) {
  const userRef = db().collection('users').doc(uid);

  setJob(jobId, { percent: 10, label: 'Verifying product...' });

  let role = 'user';
  let product = null;
  let realPrice = 0;

  try {
    // Role — and therefore price — is re-derived server-side from
    // Firestore right here, never from anything the client sent.
    // This is what makes reseller pricing safe: a 'user'-role account
    // can never talk its way into reseller prices by editing the
    // request, because the price always comes from *this* lookup.
    const roleSnap = await userRef.get();
    role = roleSnap.exists ? (roleSnap.data().role || 'user') : 'user';
    product = catalogFind(sku, role);
    if (!product) {
      throw new Error('Unknown product');
    }
    realPrice = Number(product.price);

    telegramNotify(telegramFormat('Purchase attempt', {
      username: buyerName || email, email, product: product.name,
      duration: product.duration, price: realPrice, uid, status: 'attempt',
      others: `role: ${role}`,
    }));

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
      username: buyerName || email, email, product: product ? product.name : sku,
      duration: product ? product.duration : '', price: realPrice, uid, status: 'failed',
      others: `${e.message} (role: ${role})`,
    }));
  }
}

export default router;