// src by SRT X CHEATS. Copy right SRT X CHEATS
import crypto from 'node:crypto';
import { db } from './firebase.js';
import { esc, formatNepaliDateTime } from './telegram.js';
import { makeBan } from './ban.js';
// src by SRT X CHEATS. Copy right SRT X CHEATS
import { invalidateUserDoc } from './userCache.js';
import { depositUpdate } from './proTier.js';

export const QR_MIN_AMOUNT = 100;
export const QR_MAX_AMOUNT = 100000;
// src by SRT X CHEATS. Copy right SRT X CHEATS
export const QR_MAX_PENDING = 3;
export const QR_PENDING_WINDOW_MS = 30 * 60_000;
export const QR_METHOD = 'QR';

export const botToken = () => process.env.TELEGRAM_TOPUP_AUTO_BOT || '';
// src by SRT X CHEATS. Copy right SRT X CHEATS
export function chatIds() {
  const pick = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
  const own = pick(process.env.TELEGRAM_TOPUP_AUTO_CHAT_ID);
  if (own.length) return own;
  const load = pick(process.env.TELEGRAM_LOAD_CHAT_ID);
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (load.length) return load;
  return [process.env.TELEGRAM_CHAT_ID_1, process.env.TELEGRAM_CHAT_ID_2, process.env.TELEGRAM_CHAT_ID].filter(Boolean).map(String);
}
export const adminIds = () => String(process.env.TELEGRAM_TOPUP_ADMIN_IDS || '').split(',').map((x) => x.trim()).filter(Boolean);

// src by SRT X CHEATS. Copy right SRT X CHEATS
export function webhookSecret() {
  return process.env.TELEGRAM_TOPUP_WEBHOOK_SECRET
    || crypto.createHash('sha256').update('topup-webhook:' + botToken()).digest('hex').slice(0, 48);
}
export function safeEqual(a, b) {
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export async function tg(method, body) {
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const token = botToken();
  if (!token) return null;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 7000);
  try {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) console.warn(`[topup-bot] ${method} failed: ${j.description || r.status}`);
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    return j;
  } catch (e) {
    console.warn(`[topup-bot] ${method} error: ${e?.name || 'unknown'}`);
    return null;
  } finally { clearTimeout(t); }
// src by SRT X CHEATS. Copy right SRT X CHEATS
}
export const answerCallback = (id, text, alert = false) => tg('answerCallbackQuery', { callback_query_id: id, text, show_alert: alert });
export const editMessage = (chat_id, message_id, text) =>
  tg('editMessageText', { chat_id, message_id, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: [] } });

// src by SRT X CHEATS. Copy right SRT X CHEATS
export async function registerTopupWebhook() {
  if (!botToken()) return;
  const base = String(process.env.PUBLIC_BACKEND_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
  if (!base.startsWith('https://')) {
    console.warn('[topup-bot] Set PUBLIC_BACKEND_URL (https) so the Load/Cancel buttons can reach the server.');
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    return;
  }
  const r = await tg('setWebhook', {
    url: `${base}/api/telegram/topup-webhook`, secret_token: webhookSecret(),
    allowed_updates: ['callback_query', 'message'], drop_pending_updates: false,
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  });
  if (r?.ok) console.log('[topup-bot] webhook registered');
  await tg('setMyCommands', { commands: [
    { command: 'addbalance', description: 'Add balance to a user' },
    { command: 'getdetail', description: 'Get a user\'s details' },
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    { command: 'mode', description: 'Change mode: user / reseller / pro reseller' },
    { command: 'cancel', description: 'Cancel the current command' },
  ] });
}

// src by SRT X CHEATS. Copy right SRT X CHEATS
const nrp = (n) => `NRP ${Number(n || 0).toLocaleString('en-US')}`;
const LINE = '------------------------------------------';
const THIN = '---------------------';

export function buildRequestText(p, footer = '') {
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  return [
    `<b>USER NAME</b> - ${esc(p.name || '—')}`,
    `<b>USER UID</b> - <code>${esc(p.uid)}</code>`,
    `<b>GMAIL</b> - ${esc(p.email || '—')}`,
    `<b>PHONE</b> - ${esc(p.phone || '—')}`,
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    `<b>AVAILABLE BALANCE</b> - ${esc(nrp(p.balance))}`,
    LINE,
    `<b>REQUEST BALANCE</b> - <b>${esc(nrp(p.amount))}</b>`,
    THIN,
    `<b>TX CODE</b> - <code>${esc(p.txCode)}</code>`,
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    THIN,
    `<b>DATE</b> - ${esc(formatNepaliDateTime(p.date))}`,
    `<b>IP ADDRESS</b> - <code>${esc(p.ip || '—')}</code>`,
    LINE,
    footer,
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  ].filter((x) => x !== '').join('\n');
}

export async function sendRequestToBot(reqId, p) {
  const ids = chatIds();
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (!botToken() || !ids.length) {
    console.warn('[topup-bot] TELEGRAM_TOPUP_AUTO_BOT / chat id not configured — request saved but not announced.');
    return [];
  }
  const keyboard = { inline_keyboard: [[
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    { text: 'Load ✅', callback_data: `tq:L:${reqId}` },
    { text: 'Cancel ❌', callback_data: `tq:C:${reqId}` },
  ]] };
  const sent = [];
  await Promise.all(ids.map(async (chat_id) => {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    const r = await tg('sendMessage', { chat_id, text: buildRequestText(p), parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: keyboard });
    if (r?.ok) sent.push({ chat_id: r.result.chat.id, message_id: r.result.message_id });
  }));
  return sent;
}
// src by SRT X CHEATS. Copy right SRT X CHEATS

export function newReqId() { return crypto.randomBytes(6).toString('hex'); }

export function isAllowedPress(cb) {
  const chat = cb.message?.chat?.id;
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (!chat || !chatIds().map(String).includes(String(chat))) return false;
  const allow = adminIds();
  return allow.length === 0 || allow.includes(String(cb.from?.id));
}

// src by SRT X CHEATS. Copy right SRT X CHEATS
export const FAKE_LADDER = [
  { count: 1, action: 'warning', text: 'Warning 1/3 — fake payment detected. Next fake payment = 1 day ban.' },
  { count: 2, action: '1d',      text: 'Warning 2/3 — fake payment detected again. You were banned for 1 day. Next fake payment = permanent ban.' },
  { count: 3, action: 'permanent', text: 'Warning 3/3 — fake payment detected. Account permanently banned.' },
];
// src by SRT X CHEATS. Copy right SRT X CHEATS
export const strikeStep = (count) => FAKE_LADDER[Math.min(count, FAKE_LADDER.length) - 1];

export async function resolveRequest(reqId, decision, by = 'telegram') {
  const idxRef = db().collection('topupQr').doc(reqId);
  const idx = await idxRef.get();
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (!idx.exists) return { ok: false, reason: 'Request not found' };
  const { uid } = idx.data();
  const userRef = db().collection('users').doc(uid);
  const now = new Date().toISOString();

  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const out = await db().runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) return { ok: false, reason: 'User not found' };
    const d = snap.data();
    const list = Array.isArray(d.topupRequests) ? d.topupRequests : [];
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    const i = list.findIndex((r) => r.reqId === reqId);
    if (i < 0) return { ok: false, reason: 'Request not found' };
    const r = list[i];
    if (r.status !== 'PENDING') return { ok: false, reason: `Already ${r.status}`, status: r.status };

    // src by SRT X CHEATS. Copy right SRT X CHEATS
    const next = [...list];
    const upd = {};
    let result;
    if (decision === 'load') {
      const before = Number(d.balance || 0);
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      const after = before + Number(r.amount || 0);
      next[i] = { ...r, status: 'APPROVED', reviewedAt: now, reviewedBy: by };
      upd.balance = after;
      const pro = depositUpdate(d, r.amount, after, now);
      Object.assign(upd, pro.fields);
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      upd.adminLog = [...(d.adminLog || []), { delta: Number(r.amount), note: `QR top-up approved (txCode: ${r.txCode})`, resultingBalance: after, at: now }, ...pro.log];
      result = { ok: true, decision, before, after, amount: Number(r.amount), txCode: r.txCode, proActivated: pro.activated };
    } else {
      const count = Number(d.fakePayment?.count || 0) + 1;
      const step = strikeStep(count);
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      next[i] = { ...r, status: 'REJECTED', reviewedAt: now, reviewedBy: by, fake: true };
      upd.fakePayment = { count, lastAt: now, lastTx: r.txCode, text: step.text };
      const log = [...(d.adminLog || []), { delta: 0, note: `Fake payment strike ${Math.min(count, 3)}/3 (txCode: ${r.txCode})`, resultingBalance: Number(d.balance || 0), at: now }];
      if (step.action !== 'warning') {
        upd.ban = makeBan(step.action, 'topup-auto');
        // src by SRT X CHEATS. Copy right SRT X CHEATS
        upd.banned = true;
        log.push({ delta: 0, note: `Auto-ban — ${upd.ban.label} (fake payment)`, resultingBalance: Number(d.balance || 0), at: now });
      }
      upd.adminLog = log;
      result = { ok: true, decision, count, step, amount: Number(r.amount), txCode: r.txCode };
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    }
    upd.topupRequests = next;
    tx.set(userRef, upd, { merge: true });
    tx.set(idxRef, { status: next[i].status, resolvedAt: now }, { merge: true });
    return result;
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  });
  if (out.ok) invalidateUserDoc(uid, { history: false });
  return { ...out, uid, messages: idx.data().messages || [], base: idx.data() };
}
