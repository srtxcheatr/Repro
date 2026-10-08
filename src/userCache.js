// src/userCache.js — collapses a burst of near-simultaneous reads of the
// SAME tiny users/{uid} document into one real Firestore read.
//
// THE PROBLEM THIS FIXES: a single dashboard.php load fires off
// /api/user/balance, /api/user/history, /api/user/reseller-progress,
// /api/user/policy-ack and /api/user/announcement almost at the same
// time (Promise.all). Every one of those routes used to call
// db().collection('users').doc(uid).get() independently — 5+ full
// reads of one document, every page load, for every user, which is
// exactly what was burning through the Spark plan's 50K reads/day.
//
// THE FIX: routes that only READ the user doc for display purposes call
// getUserDoc(uid) instead of hitting Firestore directly. The first call
// in any ~6s window does a real read and caches it; every other call
// for the same uid in that window reuses it. Anything that WRITES the
// doc must call invalidateUserDoc(uid) right after, so the very next
// read — even inside the TTL — sees the fresh value instead of a stale
// one.
//
// NOT used for anything transactional or money-related (checkout's
// balance check, admin's balance/topup edits, apply-reseller, redeem).
// Those all read via tx.get(ref) inside db().runTransaction(), which is
// a completely different code path from db().collection('users').doc()
// .get() — so they're structurally untouched by this cache and always
// see a fully fresh, consistent read. This file is purely an
// optimization for cheap, frequent, read-only display calls.
import { db } from './firebase.js';

const TTL_MS = 6000;
const cache = new Map(); // uid -> { exists, data, at }

export async function getUserDoc(uid) {
  const hit = cache.get(uid);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;

  const snap = await db().collection('users').doc(uid).get();
  const entry = { exists: snap.exists, data: snap.exists ? snap.data() : null, at: Date.now() };
  cache.set(uid, entry);
  return entry;
}

// Call right after writing to a user's doc anywhere in the app (profile
// save, admin balance/role edits, topup approval, a completed purchase,
// policy-ack, announcement-seen, etc.) so cached readers don't serve a
// stale copy for the rest of the TTL window.
export function invalidateUserDoc(uid) {
  cache.delete(uid);
}
