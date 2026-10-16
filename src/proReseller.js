// src/proReseller.js — PRO RESELLER approval requests + Telegram messages.
//
// Flow: user submits the form (POST /api/user/pro-reseller/apply) -> request is
// saved on users/{uid}.proReseller (status 'pending') + an index doc
// proRequests/{reqId} -> the SAME top-up bot (TELEGRAM_TOPUP_AUTO_BOT) posts the
// request with  [ Approved ✅ ]  [ CANCEL ❌ ]. See src/proTier.js for the rules.
import { db } from './firebase.js';
import { esc } from './telegram.js';
import { invalidateUserDoc } from './userCache.js';
import { tg, botToken, chatIds } from './topupQr.js';
import { PRO_MIN_TOPUP } from './proTier.js';

const LINE = '_________________________';

export function buildProRequestText(p, footer = '') {
  return [
    '<b>[Store details]</b>',
    `Name - ${esc(p.storeName || '—')}`,
    `Gmail - ${esc(p.email || '—')}`,
    `UId - <code>${esc(p.uid)}</code>`,
    LINE,
    '<b>For approval details</b>',
    `Name - ${esc(p.name || '—')}`,
    `Whatsapp business number - ${esc(p.whatsapp || '—')}`,
    `Phone number - ${esc(p.phone || '—')}`,
    `TikTok id - ${esc(p.tiktok || '—')}`,
    LINE,
    footer,
  ].filter((x) => x !== '').join('\n');
}

export async function sendProRequestToBot(reqId, p) {
  const ids = chatIds();
  if (!botToken() || !ids.length) {
    console.warn('[pro-reseller] TELEGRAM_TOPUP_AUTO_BOT / chat id not configured — request saved but not announced.');
    return [];
  }
  const keyboard = { inline_keyboard: [[
    { text: 'Approved ✅', callback_data: `pr:A:${reqId}` },
    { text: 'CANCEL ❌', callback_data: `pr:C:${reqId}` },
  ]] };
  const sent = [];
  await Promise.all(ids.map(async (chat_id) => {
    const r = await tg('sendMessage', { chat_id, text: buildProRequestText(p), parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: keyboard });
    if (r?.ok) sent.push({ chat_id: r.result.chat.id, message_id: r.result.message_id });
  }));
  return sent;
}

/** Plain info message to the admin chat(s) (no buttons). */
export async function announce(text) {
  await Promise.all(chatIds().map((chat_id) => tg('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true })));
}

export const announceProActivated = ({ uid, email, name, deposited }) => announce(
  `💎 <b>PRO RESELLER ACTIVATED</b>\n👤 ${esc(name || '—')}\n✉️ ${esc(email || '—')}\n🆔 <code>${esc(uid)}</code>\n` +
  `New top-ups: NRP ${esc(deposited)} (needed ${PRO_MIN_TOPUP})\nPro prices are now live for this account.`
);

/**
 * Atomically resolve one pro-reseller request. decision: 'approve' | 'reject'.
 * Only a user whose proReseller.status is 'pending' AND whose reqId matches can
 * be resolved, so a double press / old message can never change anything twice.
 * Approving does NOT change role or prices — the user must still make a fresh
 * top-up (see depositUpdate in proTier.js).
 */
export async function resolveProRequest(reqId, decision, by = 'telegram') {
  const idxRef = db().collection('proRequests').doc(reqId);
  const idx = await idxRef.get();
  if (!idx.exists) return { ok: false, reason: 'Request not found' };
  const { uid } = idx.data();
  const userRef = db().collection('users').doc(uid);
  const now = new Date().toISOString();

  const out = await db().runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) return { ok: false, reason: 'User not found' };
    const d = snap.data();
    const pr = d.proReseller || {};
    if (pr.reqId !== reqId) return { ok: false, reason: 'This request was replaced by a newer one', status: 'EXPIRED' };
    if (pr.status !== 'pending') return { ok: false, reason: `Already ${String(pr.status).toUpperCase()}`, status: String(pr.status).toUpperCase() };

    const approve = decision === 'approve';
    const next = approve
      ? { ...pr, status: 'approved', reviewedAt: now, reviewedBy: by, approvedAt: now, depositSinceApproval: 0, requiredDeposit: PRO_MIN_TOPUP }
      : { ...pr, status: 'rejected', reviewedAt: now, reviewedBy: by };
    const log = [...(d.adminLog || []), {
      delta: 0, resultingBalance: Number(d.balance || 0), at: now,
      note: approve ? `Pro Reseller request APPROVED (by ${by}) — needs NEW top-up NRP ${PRO_MIN_TOPUP} to activate` : `Pro Reseller request REJECTED (by ${by})`,
    }];
    tx.set(userRef, { proReseller: next, adminLog: log }, { merge: true });
    tx.set(idxRef, { status: approve ? 'APPROVED' : 'REJECTED', resolvedAt: now }, { merge: true });
    return { ok: true, decision, name: d.profileName || '', email: d.email || '' };
  });
  if (out.ok) invalidateUserDoc(uid);
  return { ...out, uid, messages: idx.data().messages || [] };
}
