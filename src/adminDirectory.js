// src by SRT X CHEATS. Copy right SRT X CHEATS
import { db } from './firebase.js';

const FULL_TTL_MS = Number(process.env.ADMIN_DIRECTORY_TTL_MS) > 0
  ? Number(process.env.ADMIN_DIRECTORY_TTL_MS)
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  : 12 * 60 * 60 * 1000;
const CHUNK = 300;

const rows = new Map();
const dirty = new Set();
// src by SRT X CHEATS. Copy right SRT X CHEATS
let loadedAt = 0;
let inflight = null;

function slim(id, d) {
  const topups = Array.isArray(d.topupRequests) ? d.topupRequests : [];
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  let last = null;
  for (const t of topups) {
    if (t.status !== 'APPROVED') continue;
    if (!last || new Date(t.date) > new Date(last.date)) last = t;
  }
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  return {
    uid: id,
    profileName: d.profileName || '',
    name: d.profileName || (d.email ? d.email.split('@')[0] : 'Unknown'),
    whatsapp: d.profilePhone || '',
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    email: d.email || '',
    balance: Number(d.balance || 0),
    totalKeysBought: Number(d.totalKeysBought || 0),
    totalSpent: Number(d.totalSpent || 0),
    lastTopupAt: last ? new Date(last.date).getTime() : null,
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    lastTopupAmount: last ? Number(last.amount || 0) : null,
    role: d.role || 'user',
  };
}

// src by SRT X CHEATS. Copy right SRT X CHEATS
export function markDirty(uid) {
  if (loadedAt && uid) dirty.add(uid);
}

export function markAllDirty() { loadedAt = 0; dirty.clear(); }
// src by SRT X CHEATS. Copy right SRT X CHEATS

async function fullLoad() {
  dirty.clear();
  const snap = await db().collection('users').get();
  rows.clear();
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  snap.forEach((doc) => rows.set(doc.id, slim(doc.id, doc.data())));
  loadedAt = Date.now();
}

async function refreshDirty() {
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const uids = [...dirty];
  dirty.clear();
  try {
    for (let i = 0; i < uids.length; i += CHUNK) {
      const part = uids.slice(i, i + CHUNK);
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      const snaps = await db().getAll(...part.map((u) => db().collection('users').doc(u)));
      snaps.forEach((s) => { if (s.exists) rows.set(s.id, slim(s.id, s.data())); else rows.delete(s.id); });
    }
  } catch (e) {
    uids.forEach((u) => dirty.add(u));
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    throw e;
  }
}

async function ensure() {
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (inflight) return inflight;
  const stale = !loadedAt || Date.now() - loadedAt > FULL_TTL_MS;
  if (!stale && !dirty.size) return;
  inflight = (async () => {
    try {
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      if (stale) await fullLoad(); else await refreshDirty();
    } catch (e) {
      if (loadedAt) console.error('[adminDirectory] refresh failed, serving last copy:', e?.message || e);
      else throw e;
    } finally {
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      inflight = null;
    }
  })();
  return inflight;
}
// src by SRT X CHEATS. Copy right SRT X CHEATS

export async function getDirectory() {
  await ensure();
  return [...rows.values()];
}
// src by SRT X CHEATS. Copy right SRT X CHEATS

export async function getStats() {
  const list = await getDirectory();
  let totalRevenue = 0, totalKeysSold = 0, totalBalance = 0;
  for (const r of list) { totalRevenue += r.totalSpent; totalKeysSold += r.totalKeysBought; totalBalance += r.balance; }
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  return { totalUsers: list.length, totalRevenue, totalKeysSold, totalBalance };
}

export async function getRankings(limit = 100) {
  const list = await getDirectory();
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  return list
    .filter((r) => r.totalSpent > 0)
    .sort((a, b) => b.totalSpent - a.totalSpent)
    .slice(0, limit)
    .map((r) => ({
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      uid: r.uid, email: r.email, profileName: r.profileName, role: r.role,
      balance: r.balance, totalSpent: r.totalSpent, totalKeysBought: r.totalKeysBought,
    }));
}
