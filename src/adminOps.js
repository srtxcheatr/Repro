// src by SRT X CHEATS. Copy right SRT X CHEATS
import { db } from './firebase.js';
import { invalidateUserDoc } from './userCache.js';
import { notifyBalanceChange } from './balanceAlerts.js';
import { activeBan, makeBan, BAN_DURATIONS } from './ban.js';
import { getDirectory } from './adminDirectory.js';
import admin from 'firebase-admin';
// src by SRT X CHEATS. Copy right SRT X CHEATS
import { depositUpdate, roleChangeUpdate, proPublicState, ROLE_LABEL } from './proTier.js';
import { esc } from './telegram.js';

export const MAX_BOT_LOAD = 100000;
const nrp = (n) => `NRP ${Number(n || 0).toLocaleString('en-US')}`;
// src by SRT X CHEATS. Copy right SRT X CHEATS

export async function findUser(identifier) {
  const idf = String(identifier || '').trim();
  if (!idf || idf.length > 200) return null;
  if (idf.includes('@')) {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    for (const e of new Set([idf, idf.toLowerCase()])) {
      const q = await db().collection('users').where('email', '==', e).limit(1).get();
      if (!q.empty) return { uid: q.docs[0].id, data: q.docs[0].data() };
    }
    return null;
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  }
  if (idf.includes('/')) return null;
  const snap = await db().collection('users').doc(idf).get();
  return snap.exists ? { uid: snap.id, data: snap.data() } : null;
}
// src by SRT X CHEATS. Copy right SRT X CHEATS

export async function creditUser(uid, amount, { note = '', actor = 'TELEGRAM BOT', by = 'telegram' } = {}) {
  const amt = Math.floor(Number(amount));
  if (!(amt > 0) || amt > MAX_BOT_LOAD) throw new Error(`Amount must be 1 – ${MAX_BOT_LOAD}`);
  const userRef = db().collection('users').doc(uid);
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const now = new Date().toISOString();

  const out = await db().runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) throw new Error('User not found');
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    const d = snap.data();
    const before = Number(d.balance || 0);
    const after = before + amt;
    const pro = depositUpdate(d, amt, after, now);
    const log = [...(d.adminLog || []), { delta: amt, note: `[${by}] ${note || 'Balance load'}`, resultingBalance: after, at: now }, ...pro.log];
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    tx.set(userRef, { balance: after, adminLog: log, ...pro.fields }, { merge: true });
    return { before, after, email: d.email || '', name: d.profileName || '', proTouched: Object.keys(pro.fields).length > 0, proActivated: pro.activated, deposited: pro.fields.proReseller?.depositSinceApproval };
  });
  invalidateUserDoc(uid, out.proTouched ? { history: false } : { history: false, balance: out.after });
  notifyBalanceChange({ actor, kind: 'load', uid, email: out.email, amount: amt, before: out.before, after: out.after, note });
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  return out;
}

export async function setUserRole(uid, role, by = 'telegram') {
  const userRef = db().collection('users').doc(uid);
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const now = new Date().toISOString();
  const out = await db().runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) throw new Error('User not found');
    const d = snap.data();
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    const upd = roleChangeUpdate(d, role, by, now);
    tx.set(userRef, { ...upd.fields, adminLog: [...(d.adminLog || []), ...upd.log] }, { merge: true });
    return { from: d.role || 'user', to: role, email: d.email || '' };
  });
  invalidateUserDoc(uid, { history: false });
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  return out;
}

export function userDetailText(uid, d) {
  const pro = proPublicState(d);
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const ban = activeBan(d);
  const reqs = (d.topupRequests || []).slice(-3).reverse()
    .map((t) => `  • ${esc(nrp(t.amount))} — ${esc(t.status || '—')} (${esc(String(t.date || '').slice(0, 10))})`).join('\n');
  const lines = [
    '👤 <b>USER DETAILS</b>',
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    `Name - ${esc(d.profileName || '—')}`,
    `Gmail - ${esc(d.email || '—')}`,
    `UID - <code>${esc(uid)}</code>`,
    `Phone - ${esc(d.profilePhone || '—')}`,
    `TikTok - ${esc(d.tiktokUser || d.tiktokName || '—')}`,
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    '_________________________',
    `Mode - <b>${esc(ROLE_LABEL[d.role || 'user'] || String(d.role).toUpperCase())}</b>`,
    `Balance - <b>${esc(nrp(d.balance))}</b>`,
    `Keys bought - ${Number(d.totalKeysBought || 0)}   Spent - ${esc(nrp(d.totalSpent))}`,
    `Status - ${esc(ban ? `BANNED (${ban.label})` : (d.requestStatus || 'Active'))}`,
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  ];
  if (pro.status !== 'none') {
    lines.push(`Pro Reseller - <b>${esc(pro.status.toUpperCase())}</b>` + (pro.deposited ? ` · unlocked by single deposit ${esc(nrp(pro.deposited))}` : ''));
  }
  if (d.fakePayment?.count) lines.push(`⚠️ Fake-payment strikes - ${Number(d.fakePayment.count)}/3`);
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (reqs) lines.push('_________________________', '<b>Last top-ups</b>', reqs);
  return lines.join('\n');
}


// ---------------------------------------------------------------------------
// Added for the private bot: cut balance, ban / unban, annulment, lists, phone lookup
// ---------------------------------------------------------------------------

const digitsOf = (v) => String(v || '').replace(/\D/g, '');

// UID, e-mail or phone number -> { uid, data } (phones are matched on the last 10 digits, so
// 98XXXXXXXX, +97798XXXXXXXX and 97798XXXXXXXX all find the same user).
export async function findUserByAny(identifier) {
  const idf = String(identifier || '').trim();
  if (!idf || idf.length > 200) return null;
  if (idf.includes('@')) return findUser(idf);
  const digits = digitsOf(idf);
  const looksLikePhone = /^\+?[\d\s\-().]{7,20}$/.test(idf) && digits.length >= 7 && digits.length <= 15;
  const looksLikeUid = /^[A-Za-z0-9_-]{20,128}$/.test(idf) && !/^\d+$/.test(idf);
  if (looksLikeUid) {
    const u = await findUser(idf);
    if (u) return u;
  }
  if (looksLikePhone) {
    const tail = digits.length >= 10 ? digits.slice(-10) : digits;
    const list = await getDirectory();
    const hits = list.filter((r) => { const d = digitsOf(r.whatsapp); return d && (d === digits || d.endsWith(tail)); });
    if (hits.length) {
      const exact = hits.find((r) => digitsOf(r.whatsapp) === digits) || hits[0];
      const snap = await db().collection('users').doc(exact.uid).get();
      if (snap.exists) return { uid: snap.id, data: snap.data() };
    }
    return null;
  }
  return looksLikeUid ? null : findUser(idf);
}

export async function debitUser(uid, amount, { note = '', actor = 'TELEGRAM BOT', by = 'telegram' } = {}) {
  const amt = Math.floor(Number(amount));
  if (!(amt > 0) || amt > MAX_BOT_LOAD) throw new Error(`Amount must be 1 – ${MAX_BOT_LOAD}`);
  const userRef = db().collection('users').doc(uid);
  const now = new Date().toISOString();
  const out = await db().runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) throw new Error('User not found');
    const d = snap.data();
    const before = Number(d.balance || 0);
    if (before - amt < 0) throw new Error(`User only has ${nrp(before)} — cannot cut ${nrp(amt)}`);
    const after = before - amt;
    const log = [...(d.adminLog || []), { delta: -amt, note: `[${by}] ${note || 'Balance cut'}`, resultingBalance: after, at: now }];
    tx.set(userRef, { balance: after, adminLog: log }, { merge: true });
    return { before, after, email: d.email || '', name: d.profileName || '' };
  });
  invalidateUserDoc(uid, { history: false, balance: out.after });
  notifyBalanceChange({ actor, kind: 'deduct', uid, email: out.email, amount: amt, before: out.before, after: out.after, note });
  return out;
}

export async function banUser(uid, duration, by = 'telegram') {
  if (!BAN_DURATIONS[duration]) throw new Error('Unknown ban duration');
  const userRef = db().collection('users').doc(uid);
  const snap = await userRef.get();
  if (!snap.exists) throw new Error('User not found');
  const d = snap.data();
  const ban = makeBan(duration, by);
  const log = [...(d.adminLog || []), { delta: 0, note: `Banned — ${ban.label} (by ${by})`, resultingBalance: Number(d.balance || 0), at: new Date().toISOString() }];
  await userRef.set({ ban, banned: true, adminLog: log }, { merge: true });
  invalidateUserDoc(uid, { history: false });
  return { ban, email: d.email || '', name: d.profileName || '' };
}

export async function unbanUser(uid, by = 'telegram') {
  const userRef = db().collection('users').doc(uid);
  const snap = await userRef.get();
  if (!snap.exists) throw new Error('User not found');
  const d = snap.data();
  const log = [...(d.adminLog || []), { delta: 0, note: `Unbanned (by ${by})`, resultingBalance: Number(d.balance || 0), at: new Date().toISOString() }];
  await userRef.set({ ban: admin.firestore.FieldValue.delete(), banned: admin.firestore.FieldValue.delete(), adminLog: log }, { merge: true });
  invalidateUserDoc(uid, { history: false });
  return { email: d.email || '', name: d.profileName || '' };
}

// Everything that restricts an account, as a list of short labels (empty = nothing to remove).
export function restrictionsOf(d) {
  const out = [];
  const ban = activeBan(d);
  if (ban) out.push(`Ban - ${ban.label}`);
  else if (d.ban || d.banned) out.push('Old / expired ban flag');
  if (d.requestStatus === 'Banned') out.push('Reseller API suspended');
  if (Number(d.fakePayment?.count || 0) > 0) out.push(`Fake-payment strikes ${Math.min(Number(d.fakePayment.count), 3)}/3 (warning page)`);
  return out;
}

// /removeallrestriction: lifts the ban, the reseller-API suspension and the fake-payment strikes (so the warning
// disappears and the next strike starts again at 1/3). Balance, history and top-up records are NOT touched.
export async function removeAllRestrictions(uid, by = 'telegram') {
  const userRef = db().collection('users').doc(uid);
  const snap = await userRef.get();
  if (!snap.exists) throw new Error('User not found');
  const d = snap.data();
  const removed = restrictionsOf(d);
  const FV = admin.firestore.FieldValue;
  const upd = { ban: FV.delete(), banned: FV.delete(), fakePayment: FV.delete() };
  if (d.requestStatus === 'Banned') upd.requestStatus = 'Active';
  upd.adminLog = [...(d.adminLog || []), { delta: 0, note: `All restrictions removed (by ${by}): ${removed.join('; ') || 'none'}`, resultingBalance: Number(d.balance || 0), at: new Date().toISOString() }];
  await userRef.set(upd, { merge: true });
  invalidateUserDoc(uid, { history: false });
  return { email: d.email || '', name: d.profileName || '', removed };
}

// Newest first, each with its index in purchaseHistory (used by annulPurchase).
export function recentPurchases(d, limit = 8) {
  const list = Array.isArray(d.purchaseHistory) ? d.purchaseHistory : [];
  return list.map((p, index) => ({ ...p, index })).slice(-limit).reverse();
}

// Annul (cancel) one purchase: refund its price, remove it from the history, undo the counters.
// `expectedAt` guards against the list having changed since the admin looked at it.
export async function annulPurchase(uid, index, expectedAt, { by = 'telegram' } = {}) {
  const userRef = db().collection('users').doc(uid);
  const now = new Date().toISOString();
  const out = await db().runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) throw new Error('User not found');
    const d = snap.data();
    const list = Array.isArray(d.purchaseHistory) ? [...d.purchaseHistory] : [];
    const entry = list[index];
    if (!entry || entry.at !== expectedAt) throw new Error('That purchase changed or was already annulled — run /annulment again');
    const price = Math.max(0, Number(entry.price) || 0);
    list.splice(index, 1);
    const before = Number(d.balance || 0);
    const after = before + price;
    const upd = {
      balance: after,
      purchaseHistory: list,
      totalKeysBought: Math.max(0, Number(d.totalKeysBought || 0) - 1),
      totalSpent: Math.max(0, Number(d.totalSpent || 0) - price),
      annulledPurchases: [...(d.annulledPurchases || []), { ...entry, annulledAt: now, annulledBy: by }],
      adminLog: [...(d.adminLog || []), { delta: price, note: `Annulment — ${entry.name || entry.sku || 'purchase'} ${entry.duration || ''} refunded (by ${by})`.replace(/\s+/g, ' '), resultingBalance: after, at: now }],
    };
    tx.set(userRef, upd, { merge: true });
    return { before, after, price, entry, email: d.email || '', name: d.profileName || '' };
  });
  invalidateUserDoc(uid);
  notifyBalanceChange({ actor: 'TELEGRAM BOT', kind: 'load', title: 'PURCHASE ANNULLED (refund)', uid, email: out.email, amount: out.price, before: out.before, after: out.after, note: `${out.entry.name || ''} ${out.entry.duration || ''}`.trim() });
  return out;
}

// "Active" money users: loaded balance, bought keys, or still hold a balance.
const isActiveRow = (r) => r.balance > 0 || r.totalSpent > 0 || r.totalKeysBought > 0 || !!r.lastTopupAt;

export async function userBalanceReport() {
  const all = await getDirectory();
  const rows = all.filter((r) => r.balance > 0).sort((a, b) => b.balance - a.balance);
  return { total: rows.reduce((s, r) => s + r.balance, 0), rows, registered: all.length };
}

export async function activeUsersReport() {
  const all = await getDirectory();
  const rows = all.filter(isActiveRow).sort((a, b) => b.totalSpent - a.totalSpent || b.balance - a.balance);
  return { rows, registered: all.length };
}

export async function revenueReport() {
  const all = await getDirectory();
  const by = { user: { n: 0, revenue: 0 }, reseller: { n: 0, revenue: 0 }, pro_reseller: { n: 0, revenue: 0 } };
  let revenue = 0, keys = 0, balance = 0, payers = 0;
  for (const r of all) {
    revenue += r.totalSpent; keys += r.totalKeysBought; balance += r.balance;
    if (r.totalSpent > 0) payers++;
    const k = by[r.role] ? r.role : 'user';
    by[k].n += 1; by[k].revenue += r.totalSpent;
  }
  return { revenue, keys, balance, payers, registered: all.length, by };
}

// Total money a user has loaded (sum of positive balance moves in the admin log).
export function totalLoaded(d) {
  const log = Array.isArray(d.adminLog) ? d.adminLog : [];
  // refunds, annulments and cashback also add balance but are not money the user paid in
  const notMoneyIn = /refund|annul|cashback|reward|redeem/i;
  const loaded = log.reduce((s, e) => s + (Number(e.delta) > 0 && !notMoneyIn.test(String(e.note || '')) ? Number(e.delta) : 0), 0);
  return loaded || (Number(d.totalSpent || 0) + Number(d.balance || 0));
}
