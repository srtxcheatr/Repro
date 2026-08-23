import express from 'express';
import crypto from 'crypto';
import { asyncHandler } from '../src/asyncHandler.js';
import { db, requireFirebaseUid, userCors } from '../src/firebase.js';
import { catalogFind } from '../src/catalog.js';
import { telegramNotify, telegramFormat } from '../src/telegram.js';

const router = express.Router();
router.use(userCors);
router.use(requireFirebaseUid);

// ============================================================
//  Fetch key from reseller API – reads from environment
// ============================================================
async function fetchRealKey(sku, product, androidId = null) {
  const API_KEY = process.env.RESELLER_API_KEY;
  const MASTER_KEY = process.env.RESELLER_MASTER_KEY;
  // ✅ सिधै adminpanels.shop प्रयोग गरिन्छ (Cloudflare हटाइयो)
  const API_URL = 'https://adminpanels.shop/api/reseller_v1.php';

  if (!API_KEY) throw new Error('RESELLER_API_KEY missing');
  if (!MASTER_KEY) throw new Error('RESELLER_MASTER_KEY missing');

  // ✅ CRITICAL FIX: Uses the exact text from your catalog (e.g. "1 DaYs", "1 Hours")
  const duration = product.duration;

  const formData = new URLSearchParams();
  formData.append('api_key', API_KEY);
  formData.append('action', 'buy');
  formData.append('product_id', product.pid);
  formData.append('duration', duration);
  if (androidId) {
    formData.append('android_id', androidId);
  }

  console.log(`[Reseller] Request: pid=${product.pid}, duration=${duration}${androidId ? `, android_id=${androidId}` : ''}`);

  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'x-master-key': MASTER_KEY,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer': 'https://adminpanels.shop/',
    'Origin': 'https://adminpanels.shop',
    'Connection': 'keep-alive',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
  };

  let response;
  try {
    // Sending directly to the API
    response = await fetch(API_URL, {
      method: 'POST',
      headers,
      body: formData.toString(),
      signal: AbortSignal.timeout(15000),
      redirect: 'follow',
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Request timed out. Please try again.');
    throw new Error(`Connection failed: ${err.message}`);
  }

  const text = await response.text();
  console.log('[Reseller] Raw response (first 500 chars):', text.slice(0, 500));

  // ---- Detect Cloudflare challenge (फेरि पनि आयो भने थाहा पाउन) ----
  if (text.includes('Just a moment') || text.includes('challenges.cloudflare.com')) {
    throw new Error('The reseller API is currently protected by Cloudflare and blocking this request. Please contact API support to whitelist your IP address or wait.');
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    if (text.trim().length > 0 && text.trim().length < 100) {
      return text.trim();
    }
    throw new Error(`Invalid response: ${text.slice(0, 200)}`);
  }

  if (!response.ok) {
    const msg = data?.message || data?.error || `HTTP ${response.status}`;
    throw new Error(`API error: ${msg}`);
  }

  if (data.success === false) {
    throw new Error(data.message || 'API reported failure');
  }

  const key = data.key || data.data?.key || data.result?.key || null;
  if (!key) {
    console.error('[Reseller] No key in response:', JSON.stringify(data));
    throw new Error('NO KEY 🔐 OUT OF STOCK PRODUCT OR UNDER MAINTENANCE 🤟');
  }

  console.log('[Reseller] Key fetched successfully');
  return key;
}

// ============================================================
//  In‑memory job tracker
// ============================================================
const jobs = new Map();
const JOB_TTL_MS = 3 * 60 * 1000;

function setJob(jobId, patch) {
  const existing = jobs.get(jobId) || {};
  jobs.set(jobId, { ...existing, ...patch });
}

// ============================================================
//  POST /checkout/start
// ============================================================
router.post('/checkout/start', asyncHandler(async (req, res) => {
  const sku = String(req.body?.sku || '');
  const buyerName = String(req.body?.name || '').trim();
  const buyerWa = String(req.body?.waNum || '').trim();
  const androidId = req.body?.android_id ? String(req.body.android_id).trim() : null;

  const product = catalogFind(sku);
  if (!product) {
    return res.status(400).json({ success: false, error: 'Unknown product' });
  }

  if (product.requiresAndroidId && !androidId) {
    return res.status(400).json({ success: false, error: 'Android ID is required for this product' });
  }

  const jobId = crypto.randomUUID();
  setJob(jobId, {
    uid: req.uid,
    percent: 0,
    label: 'Queued...',
    done: false,
    createdAt: Date.now(),
    androidId,
  });
  setTimeout(() => jobs.delete(jobId), JOB_TTL_MS);

  res.json({ success: true, jobId });

  runCheckoutJob(jobId, req.uid, req.email, sku, buyerName, buyerWa, androidId);
}));

// ============================================================
//  GET /checkout/status/:jobId
// ============================================================
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

// ============================================================
//  Background job runner
// ============================================================
async function runCheckoutJob(jobId, uid, email, sku, buyerName, buyerWa, androidId) {
  const userRef = db().collection('users').doc(uid);

  setJob(jobId, { percent: 10, label: 'Verifying product...' });

  let role = 'user';
  let product = null;
  let realPrice = 0;

  try {
    const roleSnap = await userRef.get();
    role = roleSnap.exists ? (roleSnap.data().role || 'user') : 'user';
    product = catalogFind(sku, role);
    if (!product) {
      throw new Error('Unknown product');
    }
    realPrice = Number(product.price);

    if (product.requiresAndroidId && !androidId) {
      throw new Error('Android ID is required for this product');
    }

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
        throw new Error('Please top up first then trying 🙏');
      }

      setJob(jobId, { percent: 60, label: 'Contacting reseller...' });
      const key = await fetchRealKey(sku, product, androidId);

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