// src by SRT X CHEATS. Copy right SRT X CHEATS
import admin from 'firebase-admin';
import { db } from './firebase.js';

const CACHE_MS = 5_000;
// src by SRT X CHEATS. Copy right SRT X CHEATS
const ref = () => db().collection('config').doc('gloryStock');

let cache = { at: 0, data: null };

export function invalidateStock() { cache.at = 0; }
// src by SRT X CHEATS. Copy right SRT X CHEATS

const clamp = (n) => Math.max(0, Math.floor(Number(n) || 0));

function view(d) {
  return {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    enabled: d.enabled === true,
    available: d.enabled === true ? clamp(d.available) : null,
    updatedAt: d.updatedAt || null,
  };
}
// src by SRT X CHEATS. Copy right SRT X CHEATS

async function legacyAvailable(d) {
  if (d.available !== undefined || d.enabled !== true) return d;
  let used = 0;
  try {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    const q = db().collection('gloryGroups').where('status', 'in', ['running', 'stopped']);
    used = (await q.count().get()).data().count;
  } catch (_) {  }
  return { ...d, available: clamp(clamp(d.total) - used) };
}
// src by SRT X CHEATS. Copy right SRT X CHEATS

export async function getStock({ fresh = false } = {}) {
  if (!fresh && cache.data && Date.now() - cache.at < CACHE_MS) return view(cache.data);
  const snap = await ref().get();
  let d = snap.exists ? snap.data() : {};
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  d = await legacyAvailable(d);
  cache = { at: Date.now(), data: d };
  return view(d);
}

// src by SRT X CHEATS. Copy right SRT X CHEATS
export async function setStock({ enabled, available }) {
  await ref().set({
    enabled: !!enabled,
    available: enabled ? clamp(available) : 0,
    updatedAt: Date.now(),
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  });
  invalidateStock();
  return getStock({ fresh: true });
}

// src by SRT X CHEATS. Copy right SRT X CHEATS
export async function addStock(delta) {
  const n = Math.trunc(Number(delta) || 0);
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref());
    let d = snap.exists ? snap.data() : {};
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    d = await legacyAvailable(d);
    tx.set(ref(), {
      enabled: true,
      available: clamp(clamp(d.available) + n),
      updatedAt: Date.now(),
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    });
  });
  invalidateStock();
  return getStock({ fresh: true });
}
// src by SRT X CHEATS. Copy right SRT X CHEATS

export async function reserveSlot() {
  const res = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref());
    let d = snap.exists ? snap.data() : {};
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    if (d.enabled !== true) return { unlimited: true };
    d = await legacyAvailable(d);
    const have = clamp(d.available);
    if (have <= 0) return { out: true };
    tx.set(ref(), { enabled: true, available: have - 1, updatedAt: Date.now() }, { merge: true });
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    return { taken: true };
  });
  invalidateStock();

  if (res.out) return { ok: false, stock: await getStock({ fresh: true }) };
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (res.unlimited) return { ok: true, release() {} };

  let done = false;
  return {
    ok: true,
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    async release() {
      if (done) return;
      done = true;
      try {
        await ref().set({
          // src by SRT X CHEATS. Copy right SRT X CHEATS
          available: admin.firestore.FieldValue.increment(1),
          updatedAt: Date.now(),
        }, { merge: true });
      } catch (e) { console.error('[gloryStock] could not return a squad', e); }
      invalidateStock();
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    },
  };
}

export async function returnSlot() {
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  try {
    const snap = await ref().get();
    if (!snap.exists || snap.data().enabled !== true) return;
    await ref().set({ available: admin.firestore.FieldValue.increment(1), updatedAt: Date.now() }, { merge: true });
  } catch (e) { console.error('[gloryStock] could not return a squad after refund', e); }
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  invalidateStock();
}
