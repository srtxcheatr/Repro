import express from 'express';
import crypto from 'crypto';
import admin from 'firebase-admin';
import { asyncHandler } from '../src/asyncHandler.js';
import { db, requireFirebaseUid, userCors } from '../src/firebase.js';
import { catalogFind, getMaintenanceForSku, findCustomProductFresh } from '../src/catalog.js';
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
  const API_URL = process.env.RESELLER_ENDPOINT || 'https://bantibhaiya.to/api/reseller_v1.php';

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

  // Referer/Origin must match whatever host RESELLER_ENDPOINT actually
  // points at — a stale hardcoded domain here can itself get the request
  // rejected (or flagged) by the reseller panel, independent of whether
  // the credentials are correct.
  const apiOrigin = new URL(API_URL).origin;
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'x-master-key': MASTER_KEY,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer': `${apiOrigin}/`,
    'Origin': apiOrigin,
    'Connection': 'keep-alive',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
  };

  let response;
  try {
    // Sending to API_URL (which now points to your Cloudflare Worker)
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

  // ---- Detect Cloudflare challenge ----
  if (text.includes('Just a moment') || text.includes('challenges.cloudflare.com')) {
    throw new Error('The target reseller API is still blocking Cloudflare IPs. Contact their support or try a different Worker region.');
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
    throw new Error('maintenance .or. out of stock');
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

  if (!sku) {
    return res.status(400).json({ success: false, error: 'Missing product selection. Please pick a duration and try again.' });
  }

  let product = catalogFind(sku);
  if (!product) {
    product = await findCustomProductFresh(sku);
  }
  if (!product) {
    return res.status(400).json({ success: false, error: 'Unknown product' });
  }

  const liveStatus = await getMaintenanceForSku(sku);
  if (product.maintenance || liveStatus.maintenance) {
    return res.status(409).json({
      success: false,
      error: liveStatus.maintenanceMessage || product.maintenanceMessage || 'This product is currently under maintenance.',
    });
  }
  if (product.outOfStock || liveStatus.outOfStock) {
    return res.status(409).json({
      success: false,
      error: liveStatus.outOfStockMessage || product.outOfStockMessage || 'This duration is currently out of stock.',
    });
  }
  if (product.type === 'manual') {
    return res.status(400).json({ success: false, error: 'This product is ordered via WhatsApp, not instant checkout.' });
  }

  if (product.requiresAndroidId && !androidId) {
    return res.status(400).json({ success: false, error: 'Android ID is required for this product' });
  }

  // ------------------------------------------------------------------
  // Balance + temporary-ban pre-check, BEFORE a job/Telegram-attempt is
  // ever created. Previously this product ran the full 5-step pipeline
  // (ping reseller, open a Firestore transaction, etc.) only to fail at
  // "Checking balance..." — wasting a job slot and firing a "Purchase
  // attempt" Telegram message for something that was never going to
  // succeed. Checking here means a zero-balance user never sees the key-
  // fetch animation at all; the frontend shows a topup prompt instead.
  // ------------------------------------------------------------------
  {
    const userSnap = await db().collection('users').doc(req.uid).get();
    const userData = userSnap.exists ? userSnap.data() : {};
    const role = userData.role || 'user';
    const balance = Number(userData.balance || 0);

    // An existing ban (from a prior low-balance strike) always wins,
    // regardless of whether the CURRENT attempt would have enough
    // balance — the point of the ban is "stop trying for a while", not
    // "stop trying until you happen to have money again".
    const bannedUntil = Number(userData.checkoutBanUntil || 0);
    if (bannedUntil > Date.now()) {
      return res.status(403).json({
        success: false,
        code: 'CHECKOUT_BANNED',
        error: 'Too many purchase attempts with insufficient balance. Please wait before trying again.',
        bannedUntil,
      });
    }

    // Re-resolve price the same way runCheckoutJob does (role-aware),
    // so this pre-check can't disagree with what the job would actually
    // charge. Re-run product lookup with role in case the role-specific
    // catalog has a different price for the same sku.
    let roleProduct = catalogFind(sku, role) || await findCustomProductFresh(sku, role) || product;
    const realPrice = Number(roleProduct.price);

    if (balance < realPrice) {
      const strikes = Number(userData.lowBalanceStrikes || 0) + 1;
      const updates = { lowBalanceStrikes: strikes };

      // 2nd strike -> 1-hour checkout ban. Resets to 0 once the ban
      // expires naturally (handled by simply overwriting on the next
      // strike after expiry, see below) rather than needing a cron job.
      let justBanned = false;
      if (strikes >= 2) {
        updates.checkoutBanUntil = Date.now() + 60 * 60 * 1000; // 1 hour
        updates.lowBalanceStrikes = 0; // reset the counter once the ban itself takes over
        justBanned = true;
      }
      await db().collection('users').doc(req.uid).set(updates, { merge: true });

      if (justBanned) {
        telegramNotify(telegramFormat('Checkout Banned (1h)', {
          username: userData.profileName || req.email, email: userData.email || req.email,
          phone: userData.profilePhone || '', product: roleProduct.name || sku,
          price: realPrice, uid: req.uid, status: 'failed',
          others: `2nd insufficient-balance attempt — banned until ${new Date(updates.checkoutBanUntil).toISOString()} (role: ${role})`,
        }));
        return res.status(403).json({
          success: false,
          code: 'CHECKOUT_BANNED',
          error: 'Too many purchase attempts with insufficient balance. Please wait before trying again.',
          bannedUntil: updates.checkoutBanUntil,
        });
      }

      return res.status(402).json({
        success: false,
        code: 'INSUFFICIENT_BALANCE',
        error: "You have 0 balance and can't purchase any product. Please top up first then try again.",
        balance, required: realPrice,
      });
    }

    // Balance was sufficient this time — clear any stale strike count so
    // a user doesn't get banned later from an old strike that happened
    // before they topped up.
    if (Number(userData.lowBalanceStrikes || 0) > 0) {
      await db().collection('users').doc(req.uid).set({ lowBalanceStrikes: 0 }, { merge: true });
    }
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

  // Labels below match the exact step sequence shown in the frontend's
  // delivery checklist (store.php) — keep these two in sync if either
  // changes. Percent checkpoints are unchanged from before; only the
  // label text was renamed.
  setJob(jobId, { percent: 5, label: 'Checking request...' });

  let role = 'user';
  let product = null;
  let realPrice = 0;

  try {
    const roleSnap = await userRef.get();
    role = roleSnap.exists ? (roleSnap.data().role || 'user') : 'user';
    product = catalogFind(sku, role);
    if (!product) {
      product = await findCustomProductFresh(sku, role);
    }
    if (!product) {
      throw new Error('Unknown product');
    }
    realPrice = Number(product.price);

    const liveStatus = await getMaintenanceForSku(sku);
    if (product.maintenance || liveStatus.maintenance) {
      throw new Error(liveStatus.maintenanceMessage || product.maintenanceMessage || 'This product is currently under maintenance.');
    }
    if (product.outOfStock || liveStatus.outOfStock) {
      throw new Error(liveStatus.outOfStockMessage || product.outOfStockMessage || 'This duration is currently out of stock.');
    }
    if (product.type === 'manual') {
      throw new Error('This product is ordered via WhatsApp, not instant checkout.');
    }

    if (product.requiresAndroidId && !androidId) {
      throw new Error('Android ID is required for this product');
    }

    setJob(jobId, { percent: 20, label: 'Checking product...' });

    telegramNotify(telegramFormat('Purchase attempt', {
      username: buyerName || email, email, phone: buyerWa, product: product.name,
      duration: product.duration, price: realPrice, uid, status: 'attempt',
      others: `role: ${role}`,
    }));

    setJob(jobId, { percent: 35, label: 'Checking balance...' });

    const result = await db().runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      const currentBalance = snap.exists ? Number(snap.data().balance || 0) : 0;

      if (currentBalance < realPrice) {
        throw new Error('Please top up first then trying 🙏');
      }

      setJob(jobId, { percent: 55, label: 'Connecting to server...' });
      const key = await fetchRealKey(sku, product, androidId);
      // "Server connected..." only fires once fetchRealKey has actually
      // returned a key — this step reflects a real completed network
      // call, not a fixed-time fake animation step.
      setJob(jobId, { percent: 80, label: 'Server connected...' });

      setJob(jobId, { percent: 90, label: 'Finalizing order...' });
      const newBalance = currentBalance - realPrice;
      const historyEntry = {
        at: new Date().toISOString(), sku, row: product.row, name: product.name, duration: product.duration,
        price: realPrice, key, buyerName, buyerWa,
      };
      const purchaseHistory = snap.exists ? (snap.data().purchaseHistory || []) : [];
      purchaseHistory.push(historyEntry);

      tx.set(userRef, {
        balance: newBalance, purchaseHistory,
        totalKeysBought: admin.firestore.FieldValue.increment(1),
        totalSpent: admin.firestore.FieldValue.increment(realPrice),
      }, { merge: true });
      // currentBalance/newBalance travel out of the transaction here so
      // the Telegram message below can show the before/after NRP amounts
      // — they weren't being returned at all before this change.
      return { key, newBalance, currentBalance };
    });

    setJob(jobId, { percent: 100, label: 'Delivered!', done: true, success: true, key: result.key, newBalance: result.newBalance });

    telegramNotify(telegramFormat('Purchase success', {
      username: buyerName || email, email, phone: buyerWa, product: product.name,
      duration: product.duration, price: realPrice, key: result.key, uid, status: 'success',
      balanceBefore: result.currentBalance, balanceAfter: result.newBalance,
    }));
  } catch (e) {
    setJob(jobId, { percent: 100, done: true, success: false, error: e.message, label: 'Failed' });

    telegramNotify(telegramFormat('Purchase rejected', {
      username: buyerName || email, email, phone: buyerWa, product: product ? product.name : sku,
      duration: product ? product.duration : '', price: realPrice, uid, status: 'failed',
      others: `${e.message} (role: ${role})`,
    }));
  }
}

export default router;