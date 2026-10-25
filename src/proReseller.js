// src by SRT X CHEATS. Copy right SRT X CHEATS
import { db } from './firebase.js';
import { esc } from './telegram.js';
import { invalidateUserDoc } from './userCache.js';
import { tg, botToken, chatIds } from './topupQr.js';
// src by SRT X CHEATS. Copy right SRT X CHEATS
import { PRO_MIN_TOPUP } from './proTier.js';

const LINE = '_________________________';

export function buildProRequestText(p, footer = '') {
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  return [
    '<b>[Store details]</b>',
    `Name - ${esc(p.storeName || '—')}`,
    `Gmail - ${esc(p.email || '—')}`,
    `UId - <code>${esc(p.uid)}</code>`,
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    LINE,
    '<b>For approval details</b>',
    `Name - ${esc(p.name || '—')}`,
    `Whatsapp business number - ${esc(p.whatsapp || '—')}`,
    `Phone number - ${esc(p.phone || '—')}`,
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    `TikTok id - ${esc(p.tiktok || '—')}`,
    LINE,
    footer,
  ].filter((x) => x !== '').join('\n');
}
// src by SRT X CHEATS. Copy right SRT X CHEATS

export async function sendProRequestToBot(reqId, p) {
  const ids = chatIds();
  if (!botToken() || !ids.length) {
    console.warn('[pro-reseller] TELEGRAM_TOPUP_AUTO_BOT / chat id not configured — request saved but not announced.');
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    return [];
  }
  const keyboard = { inline_keyboard: [[
    { text: 'Approved', style: 'success', callback_data: `pr:A:${reqId}` },
    { text: 'Cancel', style: 'danger', callback_data: `pr:C:${reqId}` },
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  ]] };
  const sent = [];
  await Promise.all(ids.map(async (chat_id) => {
    const r = await tg('sendMessage', { chat_id, text: buildProRequestText(p), parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: keyboard });
    if (r?.ok) sent.push({ chat_id: r.result.chat.id, message_id: r.result.message_id });
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  }));
  return sent;
}

export async function announce(text) {
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  await Promise.all(chatIds().map((chat_id) => tg('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true })));
}

export const announceProActivated = ({ uid, email, name, deposited }) => announce(
  `💎 <b>PRO RESELLER ACTIVATED</b>\n👤 ${esc(name || '—')}\n✉️ ${esc(email || '—')}\n🆔 <code>${esc(uid)}</code>\n` +
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  `New top-ups: NRP ${esc(deposited)} (needed ${PRO_MIN_TOPUP})\nPro prices are now live for this account.`
);

export async function resolveProRequest(reqId, decision, by = 'telegram') {
  const idxRef = db().collection('proRequests').doc(reqId);
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const idx = await idxRef.get();
  if (!idx.exists) return { ok: false, reason: 'Request not found' };
  const { uid } = idx.data();
  const userRef = db().collection('users').doc(uid);
  const now = new Date().toISOString();
// src by SRT X CHEATS. Copy right SRT X CHEATS

  const out = await db().runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) return { ok: false, reason: 'User not found' };
    const d = snap.data();
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    const pr = d.proReseller || {};
    if (pr.reqId !== reqId) return { ok: false, reason: 'This request was replaced by a newer one', status: 'EXPIRED' };
    if (pr.status !== 'pending') return { ok: false, reason: `Already ${String(pr.status).toUpperCase()}`, status: String(pr.status).toUpperCase() };

    const approve = decision === 'approve';
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    const next = approve
      ? { ...pr, status: 'approved', reviewedAt: now, reviewedBy: by, approvedAt: now, depositSinceApproval: 0, requiredDeposit: PRO_MIN_TOPUP }
      : { ...pr, status: 'rejected', reviewedAt: now, reviewedBy: by };
    const log = [...(d.adminLog || []), {
      delta: 0, resultingBalance: Number(d.balance || 0), at: now,
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      note: approve ? `Pro Reseller request APPROVED (by ${by}) — needs NEW top-up NRP ${PRO_MIN_TOPUP} to activate` : `Pro Reseller request REJECTED (by ${by})`,
    }];
    tx.set(userRef, { proReseller: next, adminLog: log }, { merge: true });
    tx.set(idxRef, { status: approve ? 'APPROVED' : 'REJECTED', resolvedAt: now }, { merge: true });
    return { ok: true, decision, name: d.profileName || '', email: d.email || '' };
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  });
  if (out.ok) invalidateUserDoc(uid, { history: false });
  return { ...out, uid, messages: idx.data().messages || [] };
}
