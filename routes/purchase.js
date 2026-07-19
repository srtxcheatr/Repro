import express from 'express';
import { asyncHandler } from '../src/asyncHandler.js';
import { db, requireFirebaseUid, userCors } from '../src/firebase.js';
import { catalogFind } from '../src/catalog.js';
import { telegramNotify, telegramFormat } from '../src/telegram.js';

const router = express.Router();
router.use(userCors);
router.use(requireFirebaseUid);

/**
 * Fetches a product key directly from the reseller API.
 * No Cloudflare Worker involved.
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
      signal: AbortSignal.timeout(15000), // 15 seconds timeout
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Reseller API request timed out. Please try again.');
    }
    throw new Error(`Failed to connect to reseller API: ${err.message}`);
  }

  // ---- Parse response ----
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    // If response is not JSON, treat as plain text (maybe key)
    if (text.trim().length > 0 && text.trim().length < 100) {
      return text.trim(); // likely a key
    }
    throw new Error(`Reseller API returned invalid response: ${text.slice(0, 200)}`);
  }

  // Check HTTP status
  if (!response.ok) {
    const msg = data?.message || data?.error || `HTTP ${response.status}`;
    throw new Error(`Reseller API error: ${msg}`);
  }

  // Check explicit success flag (if present)
  if (data.success === false) {
    throw new Error(data.message || 'Reseller API reported failure');
  }

  // Extract key from various possible structures
  const key =
    data.key ||
    (data.data && data.data.key) ||
    (data.result && data.result.key) ||
    (typeof data === 'string' ? data : null);

  if (!key) {
    console.error('Reseller API response missing key:', JSON.stringify(data));
    throw new Error('Reseller API returned no key. Please contact support.');
  }

  return key;
}

// POST /api/purchase/checkout
router.post('/checkout', asyncHandler(async (req, res) => {
  const sku = String(req.body?.sku || '');
  const buyerName = String(req.body?.name || '').trim();
  const buyerWa = String(req.body?.waNum || '').trim();

  const product = catalogFind(sku);
  if (!product) {
    return res.status(400).json({ success: false, error: 'Unknown product' });
  }
  const realPrice = Number(product.price);
  const userRef = db().collection('users').doc(req.uid);

  telegramNotify(telegramFormat('Purchase attempt', {
    username: buyerName || req.email,
    email: req.email,
    product: product.name,
    price: realPrice,
    uid: req.uid,
    status: 'attempt',
  }));

  try {
    const result = await db().runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      const currentBalance = snap.exists ? Number(snap.data().balance || 0) : 0;

      if (currentBalance < realPrice) {
        throw new Error('Insufficient balance');
      }

      const key = await fetchRealKey(sku, product);

      const newBalance = currentBalance - realPrice;
      const historyEntry = {
        at: new Date().toISOString(),
        name: product.name,
        duration: product.duration,
        price: realPrice,
        key,
        buyerName,
        buyerWa,
      };
      const purchaseHistory = snap.exists ? (snap.data().purchaseHistory || []) : [];
      purchaseHistory.push(historyEntry);

      tx.set(userRef, { balance: newBalance, purchaseHistory }, { merge: true });
      return { key, newBalance };
    });

    telegramNotify(telegramFormat('Purchase success', {
      username: buyerName || req.email,
      email: req.email,
      product: product.name,
      price: realPrice,
      uid: req.uid,
      status: 'success',
    }));

    res.json({ success: true, key: result.key, newBalance: result.newBalance });
  } catch (e) {
    telegramNotify(telegramFormat('Purchase rejected', {
      username: buyerName || req.email,
      email: req.email,
      product: product.name,
      price: realPrice,
      uid: req.uid,
      status: 'failed',
      others: e.message,
    }));
    res.status(402).json({ success: false, error: e.message });
  }
}));

export default router;