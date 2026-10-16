// src/adminOps.js — account operations shared by the Telegram bot commands
// (/addbalance, /getdetail, /mode). The same rules as the admin panel:
// balance changes are transactional + logged, and a top-up made after a
// Pro Reseller approval counts toward activation.
import { db } from './firebase.js';
import { invalidateUserDoc } from './userCache.js';
import { notifyBalanceChange } from './balanceAlerts.js';
import { activeBan } from './ban.js';
import { depositUpdate, roleChangeUpdate, proPublicState, ROLE_LABEL } from './proTier.js';
import { esc } from './telegram.js';

export const MAX_BOT_LOAD = 100000;
const nrp = (n) => `NRP ${Number(n || 0).toLocaleString('en-US')}`;

/** Find a user by Firebase UID or by e-mail. Returns { uid, data } or null. */
export async function findUser(identifier) {
  const idf = String(identifier || '').trim();
  if (!idf || idf.length > 200) return null;
  if (idf.includes('@')) {
    for (const e of new Set([idf, idf.toLowerCase()])) {
      const q = await db().collection('users').where('email', '==', e).limit(1).get();
      if (!q.empty) return { uid: q.docs[0].id, data: q.docs[0].data() };
    }
    return null;
  }
  if (idf.includes('/')) return null; // would be an invalid Firestore doc path
  const snap = await db().collection('users').doc(idf).get();
  return snap.exists ? { uid: snap.id, data: snap.data() } : null;
}

/** Credit balance (top-up). Returns { before, after, email, proActivated, proData }. */
export async function creditUser(uid, amount, { note = '', actor = 'TELEGRAM BOT', by = 'telegram' } = {}) {
  const amt = Math.floor(Number(amount));
  if (!(amt > 0) || amt > MAX_BOT_LOAD) throw new Error(`Amount must be 1 – ${MAX_BOT_LOAD}`);
  const userRef = db().collection('users').doc(uid);
  const now = new Date().toISOString();

  const out = await db().runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) throw new Error('User not found');
    const d = snap.data();
    const before = Number(d.balance || 0);
    const after = before + amt;
    const pro = depositUpdate(d, amt, after, now);
    const log = [...(d.adminLog || []), { delta: amt, note: `[${by}] ${note || 'Balance load'}`, resultingBalance: after, at: now }, ...pro.log];
    tx.set(userRef, { balance: after, adminLog: log, ...pro.fields }, { merge: true });
    return { before, after, email: d.email || '', name: d.profileName || '', proActivated: pro.activated, deposited: pro.fields.proReseller?.depositSinceApproval };
  });
  invalidateUserDoc(uid);
  notifyBalanceChange({ actor, kind: 'load', uid, email: out.email, amount: amt, before: out.before, after: out.after, note });
  return out;
}

/** Change a user's mode: 'user' | 'reseller' | 'pro_reseller'. */
export async function setUserRole(uid, role, by = 'telegram') {
  const userRef = db().collection('users').doc(uid);
  const now = new Date().toISOString();
  const out = await db().runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) throw new Error('User not found');
    const d = snap.data();
    const upd = roleChangeUpdate(d, role, by, now);
    tx.set(userRef, { ...upd.fields, adminLog: [...(d.adminLog || []), ...upd.log] }, { merge: true });
    return { from: d.role || 'user', to: role, email: d.email || '' };
  });
  invalidateUserDoc(uid);
  return out;
}

/** HTML text for /getdetail. */
export function userDetailText(uid, d) {
  const pro = proPublicState(d);
  const ban = activeBan(d);
  const reqs = (d.topupRequests || []).slice(-3).reverse()
    .map((t) => `  • ${esc(nrp(t.amount))} — ${esc(t.status || '—')} (${esc(String(t.date || '').slice(0, 10))})`).join('\n');
  const lines = [
    '👤 <b>USER DETAILS</b>',
    `Name - ${esc(d.profileName || '—')}`,
    `Gmail - ${esc(d.email || '—')}`,
    `UID - <code>${esc(uid)}</code>`,
    `Phone - ${esc(d.profilePhone || '—')}`,
    `TikTok - ${esc(d.tiktokUser || d.tiktokName || '—')}`,
    '_________________________',
    `Mode - <b>${esc(ROLE_LABEL[d.role || 'user'] || String(d.role).toUpperCase())}</b>`,
    `Balance - <b>${esc(nrp(d.balance))}</b>`,
    `Keys bought - ${Number(d.totalKeysBought || 0)}   Spent - ${esc(nrp(d.totalSpent))}`,
    `Status - ${esc(ban ? `BANNED (${ban.label})` : (d.requestStatus || 'Active'))}`,
  ];
  if (pro.status !== 'none') {
    lines.push(`Pro request - <b>${esc(pro.status.toUpperCase())}</b>` + (pro.status === 'approved' ? ` · new top-up ${esc(nrp(pro.deposited))} / ${esc(nrp(pro.required))}` : ''));
  }
  if (d.fakePayment?.count) lines.push(`⚠️ Fake-payment strikes - ${Number(d.fakePayment.count)}/3`);
  if (reqs) lines.push('_________________________', '<b>Last top-ups</b>', reqs);
  return lines.join('\n');
}
