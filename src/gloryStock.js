// src/gloryStock.js — stock for the FF Glory Bot, managed as a plain counter.
//
// The admin enters a number of bot squads (config/gloryStock { enabled, available }).
//   - Admin sets 3        -> store shows "3 available"
//   - A user launches 1   -> store shows "2 available"   (automatic)
//   - It reaches 0        -> store shows "Out of stock"  (automatic)
//   - Admin adds more     -> available again             (automatic)
//
// A launched squad is SOLD: deleting it or letting it end does NOT give the
// slot back (that was the old "1/2 available" confusion). The only time a slot
// returns automatically is when a launch fails before it was ever created
// (upstream error, refund) — see reserveSlot().release().
//
// enabled === false (the default) means "no limit" — stores that never touch
// this setting behave exactly as before.
//
// The counter is changed inside a Firestore transaction, so two people pressing
// "Launch" at the same moment can never take the last squad twice.
import admin from 'firebase-admin';
import { db } from './firebase.js';

const CACHE_MS = 5_000;
const ref = () => db().collection('config').doc('gloryStock');

let cache = { at: 0, data: null };

export function invalidateStock() { cache.at = 0; }

const clamp = (n) => Math.max(0, Math.floor(Number(n) || 0));

function view(d) {
  return {
    enabled: d.enabled === true,
    available: d.enabled === true ? clamp(d.available) : null,
    updatedAt: d.updatedAt || null,
  };
}

// Old versions stored { enabled, total } and counted live groups. If the doc
// has no `available` yet, derive it ONCE (total - groups still alive) so the
// switch to the counter doesn't change what the store is showing.
async function legacyAvailable(d) {
  if (d.available !== undefined || d.enabled !== true) return d;
  let used = 0;
  try {
    const q = db().collection('gloryGroups').where('status', 'in', ['running', 'stopped']);
    used = (await q.count().get()).data().count;
  } catch (_) { /* leave 0 */ }
  return { ...d, available: clamp(clamp(d.total) - used) };
}

export async function getStock({ fresh = false } = {}) {
  if (!fresh && cache.data && Date.now() - cache.at < CACHE_MS) return view(cache.data);
  const snap = await ref().get();
  let d = snap.exists ? snap.data() : {};
  d = await legacyAvailable(d);
  cache = { at: Date.now(), data: d };
  return view(d);
}

// Admin: set the exact number of squads available now.
export async function setStock({ enabled, available }) {
  await ref().set({
    enabled: !!enabled,
    available: enabled ? clamp(available) : 0,
    updatedAt: Date.now(),
  });
  invalidateStock();
  return getStock({ fresh: true });
}

// Admin: add (or, with a negative number, remove) squads from what is left.
export async function addStock(delta) {
  const n = Math.trunc(Number(delta) || 0);
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref());
    let d = snap.exists ? snap.data() : {};
    d = await legacyAvailable(d);
    tx.set(ref(), {
      enabled: true,
      available: clamp(clamp(d.available) + n),
      updatedAt: Date.now(),
    });
  });
  invalidateStock();
  return getStock({ fresh: true });
}

// Take one squad. -> { ok:true, release() } or { ok:false, stock }
// release() puts the squad back — call it ONLY if the launch never happened.
export async function reserveSlot() {
  const res = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref());
    let d = snap.exists ? snap.data() : {};
    if (d.enabled !== true) return { unlimited: true };
    d = await legacyAvailable(d);
    const have = clamp(d.available);
    if (have <= 0) return { out: true };
    tx.set(ref(), { enabled: true, available: have - 1, updatedAt: Date.now() }, { merge: true });
    return { taken: true };
  });
  invalidateStock();

  if (res.out) return { ok: false, stock: await getStock({ fresh: true }) };
  if (res.unlimited) return { ok: true, release() {} };

  let done = false;
  return {
    ok: true,
    async release() {
      if (done) return;
      done = true;
      try {
        await ref().set({
          available: admin.firestore.FieldValue.increment(1),
          updatedAt: Date.now(),
        }, { merge: true });
      } catch (e) { console.error('[gloryStock] could not return a squad', e); }
      invalidateStock();
    },
  };
}
