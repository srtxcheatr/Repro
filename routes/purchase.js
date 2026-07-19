import express from 'express';
import { asyncHandler } from '../src/asyncHandler.js';
import { db, requireFirebaseUid, userCors } from '../src/firebase.js';
import { catalogFind } from '../src/catalog.js';
import { telegramNotify, telegramFormat } from '../src/telegram.js';

const router = express.Router();
router.use(userCors);
router.use(requireFirebaseUid);

/**
 * Fetches a product key from the Cloudflare Worker (secure proxy).
 *
 * Error cases handled:
 * - Missing environment variables (RESELLER_WORKER_URL, WORKER_INTERNAL_SECRET)
 * - Network errors / timeout (cannot reach Worker)
 * - Non‑JSON / malformed response
 * - HTTP error status (4xx/5xx)
 * - success: false in response
 * - No key in response
 */
async function fetchRealKey(sku, product) {
  const workerUrl = process.env.RESELLER_WORKER_URL;
  const secret = process.env.WORKER_INTERNAL_SECRET;

  if (!workerUrl) {
    throw new Error('Reseller service URL not configured (RESELLER_WORKER_URL missing)');
  }
  if (!secret) {
    throw new Error('Internal secret not configured (WORKER_INTERNAL_SECRET missing)');
  }

  const payload = {
    pid: product.pid,
    duration: product.duration,
    productName: product.name,
  };

  let response;
  try {
    response = await fetch(workerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': secret,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000), // 10 seconds timeout
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Reseller service request timed out. Please try again.');
    }
    // Network errors (DNS, connection refused, etc.)
    throw new Error(`Failed to connect to reseller service: ${err.message}`);
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    // If response is not JSON, capture raw text for debugging
    let text = '';
    try {
      text = await response.text();
    } catch (_) {}
    throw new Error(`Reseller service returned invalid response (${response.status}): ${text.slice(0, 200)}`);
  }

  // Check HTTP status
  if (!response.ok) {
    const msg = data?.message || data?.error || `HTTP ${response.status}`;
    throw new Error(`Reseller service error: ${msg}`);
  }

  // Check explicit failure flag
  if (data.success === false) {
    throw new Error(data.message || 'Reseller service reported failure');
  }

  // Extract key from various response structures
  const key =
    data.key ||
    (data.data && data.data.key) ||
    (data.result && data.result.key) ||
    (typeof data === 'string' ? data : null);

  if (!key) {
    // Log the full response (server‑side only) for debugging
    console.error('Reseller response missing key:', JSON.stringify(data));
    throw new Error('Reseller service returned no key. Please contact support.');
  }

  return key;
}

// POST /api/purchase/checkout  { sku, name, waNum }
router.post('/checkout', asyncHandler(async (req, res) => {
  const sku = String(req.body?.sku || '');
  const buyerName = String(req.body?.name || '').trim();
  const buyerWa = String(req.body?.waNum || '').trim();

  // ---- 1. Real price authority: look up the product server-side. ----
  const product = catalogFind(sku);
  if (!product) {
    return res.status(400).json({ success: false, error: 'Unknown product' });
  }
  const realPrice = Number(product.price);
  const userRef = db().collection('users').doc(req.uid);

  telegramNotify(telegramFormat('Purchase attempt', {
    username: buyerName || req.email, email: req.email, product: product.name,
    price: realPrice, uid: req.uid, status: 'attempt',
  }));

  try {
    // ---- 2. Balance check + deduction, atomically. ----
    const result = await db().runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      const currentBalance = snap.exists ? Number(snap.data().balance || 0) : 0;

      if (currentBalance < realPrice) {
        throw new Error('Insufficient balance');
      }

      // ---- 3. Fetch/deliver the actual product key (now fully implemented). ----
      const key = await fetchRealKey(sku, product);

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

    telegramNotify(telegramFormat('Purchase success', {
      username: buyerName || req.email, email: req.email, product: product.name,
      price: realPrice, uid: req.uid, status: 'success',
    }));

    res.json({ success: true, key: result.key, newBalance: result.newBalance });
  } catch (e) {
    telegramNotify(telegramFormat('Purchase rejected', {
      username: buyerName || req.email, email: req.email, product: product.name,
      price: realPrice, uid: req.uid, status: 'failed', others: e.message,
    }));
    res.status(402).json({ success: false, error: e.message });
  }
}));

export default router;