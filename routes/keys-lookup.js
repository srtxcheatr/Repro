import express from 'express';
import { asyncHandler } from '../src/asyncHandler.js';
import { db, userCors } from '../src/firebase.js';
import { getUserDoc } from '../src/userCache.js';

const KEY_INDEX_TTL_MS = 10 * 60 * 1000;
const KEY_INDEX_MIN_REBUILD_MS = 60 * 1000;
let keyIndex = null;       // Map(apikey -> uid)
let keyIndexAt = 0;
let keyIndexLoading = null;

async function rebuildKeyIndex() {
  if (keyIndexLoading) return keyIndexLoading;
  keyIndexLoading = (async () => {
    try {
      const snap = await db().collection('users').get();
      const idx = new Map();
      for (const doc of snap.docs) {
        for (const k of doc.data().apiKeys || []) if (k.key && k.active) idx.set(k.key, doc.id);
      }
      keyIndex = idx;
      keyIndexAt = Date.now();
    } finally {
      keyIndexLoading = null;
    }
  })();
  return keyIndexLoading;
}

async function findUidByApiKey(apikey) {
  const age = Date.now() - keyIndexAt;
  if (!keyIndex || age > KEY_INDEX_TTL_MS) await rebuildKeyIndex();
  let uid = keyIndex.get(apikey);
  // Miss on a not-too-old index: maybe a brand-new key — allow a rebuild, but rate-limited.
  if (!uid && Date.now() - keyIndexAt > KEY_INDEX_MIN_REBUILD_MS) {
    await rebuildKeyIndex();
    uid = keyIndex.get(apikey);
  }
  return uid || null;
}

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

  // Firestore can't query "array contains an object where key=X", so the
  // old code scanned the WHOLE users collection on every request (one read
  // per user, per call — and this endpoint is public). Now one scan builds
  // an apikey -> uid index that is reused for KEY_INDEX_TTL_MS; an unknown
  // key can force at most one rebuild per KEY_INDEX_MIN_REBUILD_MS, so
  // guessing keys can't turn into a read-quota attack either.
  const uid = await findUidByApiKey(apikey);
  const ownerSnap = uid ? await getUserDoc(uid) : null;
  const owner = ownerSnap?.exists && (ownerSnap.data.apiKeys || []).some((k) => k.key === apikey && k.active)
    ? { id: uid, data: () => ownerSnap.data }
    : null;

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
