import express from 'express';
import { asyncHandler } from '../src/asyncHandler.js';
import { db, userCors } from '../src/firebase.js';

const router = express.Router();
router.use(userCors);

// GET /api/keys?apikey=srtx_xxxxx
//
// Public, apikey-authenticated (not Firebase auth) — this is what
// the "./api-keys" integration guide in the store points people at,
// so a user can pull their own purchased keys into their own site.
// Auth here is the generated API key itself, not a login session.
router.get('/', asyncHandler(async (req, res) => {
  const apikey = String(req.query.apikey || '').trim();
  if (!apikey) {
    return res.status(400).json({ success: false, error: 'Provide ?apikey=' });
  }

  // No efficient way to query "array contains object where key=X"
  // in Firestore, so this scans users — fine at this project's scale
  // (see the same tradeoff made for admin top-up lookups). If this
  // ever needs to scale past a few thousand users, API keys should
  // move to their own top-level collection instead.
  const snap = await db().collection('users').get();
  let owner = null;
  for (const doc of snap.docs) {
    const keys = doc.data().apiKeys || [];
    if (keys.some((k) => k.key === apikey && k.active)) {
      owner = doc;
      break;
    }
  }

  if (!owner) {
    return res.status(401).json({ success: false, error: 'Invalid or revoked API key' });
  }

  const purchases = owner.data().purchaseHistory || [];
  res.json({
    success: true,
    uid: owner.id,
    keys: purchases.map((p) => ({
      product: p.name || '',
      duration: p.duration || '',
      key: p.key || '',
      date: p.at || '',
    })),
  });
}));

export default router;
