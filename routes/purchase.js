import express from 'express';
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

      // ---- 3. Fetch/deliver the actual product key (your stub). ----
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
