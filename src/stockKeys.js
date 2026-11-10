// Manual key stock: keys the owner pastes in by hand, one pool per duration (sku).
// Keys live in their own collection (`stockKeys`) so they are never sent to the storefront;
// the duration's customProducts doc only carries a public `stock` COUNT.
import crypto from 'crypto';
import admin from 'firebase-admin';
import { db } from './firebase.js';

export const STOCK_COLL = 'stockKeys';
export const MAX_KEYS_PER_ADD = 100;
export const MAX_KEY_LEN = 500;

const keyDocId = (sku, key) => crypto.createHash('sha1').update(`${sku}\u0000${key}`).digest('hex');

// Trim, drop empties, drop duplicates inside the batch.
export function cleanKeys(input) {
  const list = Array.isArray(input) ? input : [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const k = String(raw ?? '').trim();
    if (!k) continue;
    if (k.length > MAX_KEY_LEN) throw Object.assign(new Error(`A key is longer than ${MAX_KEY_LEN} characters`), { status: 400 });
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

// Adds keys to one duration. Keys already in stock for that duration are skipped (not double-counted).
export async function addKeys(sku, keys) {
  const refs = keys.map((k) => db().collection(STOCK_COLL).doc(keyDocId(sku, k)));
  const existing = refs.length ? await db().getAll(...refs) : [];
  const fresh = [];
  existing.forEach((snap, i) => { if (!snap.exists) fresh.push({ ref: refs[i], key: keys[i] }); });

  if (fresh.length) {
    const batch = db().batch();
    const now = Date.now();
    for (const { ref, key } of fresh) batch.set(ref, { sku, key, createdAt: now });
    batch.update(db().collection('customProducts').doc(sku), { stock: admin.firestore.FieldValue.increment(fresh.length) });
    await batch.commit();
  }
  return { added: fresh.length, skipped: keys.length - fresh.length };
}

export async function listKeys(sku, limit = 500) {
  const snap = await db().collection(STOCK_COLL).where('sku', '==', sku).limit(limit).get();
  return snap.docs.map((d) => ({ id: d.id, key: d.data().key, createdAt: d.data().createdAt || 0 }))
    .sort((a, b) => a.createdAt - b.createdAt);
}

export async function removeKey(sku, id) {
  const ref = db().collection(STOCK_COLL).doc(String(id));
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data().sku !== sku) return false;
    tx.delete(ref);
    tx.update(db().collection('customProducts').doc(sku), { stock: admin.firestore.FieldValue.increment(-1) });
    return true;
  });
}

// Used when a duration is deleted: its unsold keys go with it.
export async function deleteAllKeys(sku) {
  for (;;) {
    const snap = await db().collection(STOCK_COLL).where('sku', '==', sku).limit(400).get();
    if (snap.empty) return;
    const batch = db().batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    if (snap.size < 400) return;
  }
}

// Call INSIDE a Firestore transaction, before any write. Returns the oldest key + a function that
// consumes it. Two buyers can never get the same key: the transaction retries the loser.
export async function takeKeyInTx(tx, sku) {
  const q = db().collection(STOCK_COLL).where('sku', '==', sku).limit(1);
  const snap = await tx.get(q);
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return {
    key: doc.data().key,
    consume() {
      tx.delete(doc.ref);
      tx.update(db().collection('customProducts').doc(sku), { stock: admin.firestore.FieldValue.increment(-1) });
    },
  };
}

// API orders: take up to `n` keys for one duration in a single atomic step.
// Returns the keys actually taken (fewer than n, or none, when stock runs short).
export async function takeKeys(sku, n) {
  const want = Math.max(1, Math.min(MAX_KEYS_PER_ADD, Math.floor(Number(n) || 1)));
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(db().collection(STOCK_COLL).where('sku', '==', sku).limit(want));
    if (snap.empty) return [];
    const keys = [];
    snap.docs.forEach((d) => { keys.push(d.data().key); tx.delete(d.ref); });
    tx.update(db().collection('customProducts').doc(sku), { stock: admin.firestore.FieldValue.increment(-keys.length) });
    return keys;
  });
}
