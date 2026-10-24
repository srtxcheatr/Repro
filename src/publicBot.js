// src by SRT X CHEATS. Copy right SRT X CHEATS
// PUBLIC bot - anyone can check a reseller/user by sending a phone number, e-mail or UID.
//   User 1 sends details of User 2  ->  bot shows "SRT X CHEATS USER DETAILS"  ->  [Report] [Ok]
//   [Report] asks for the report text and delivers it to the admins (and stores it in Firestore).
// Env: TELEGRAM_PUBLIC_BOT_TOKEN (required), PUBLIC_BACKEND_URL (https, for the webhook),
//      TELEGRAM_PUBLIC_WEBHOOK_SECRET (optional), PUBLIC_BOT_MASK_CONTACT=1 (hide middle of number/e-mail).
import crypto from 'node:crypto';
import { db } from './firebase.js';
import { findUserByAny, totalLoaded } from './adminOps.js';
import { activeBan } from './ban.js';
import { ROLE_LABEL } from './proTier.js';
import { esc, telegramNotify, formatNepaliDateTime } from './telegram.js';
import { tg as privateTg, chatIds as adminChatIds } from './topupQr.js';

export const publicToken = () => process.env.TELEGRAM_PUBLIC_BOT_TOKEN || '';
export function publicWebhookSecret() {
  return process.env.TELEGRAM_PUBLIC_WEBHOOK_SECRET
    || crypto.createHash('sha256').update('public-webhook:' + publicToken()).digest('hex').slice(0, 48);
}

async function api(method, body) {
  const token = publicToken();
  if (!token) return null;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) console.warn(`[public-bot] ${method} failed: ${j.description || r.status}`);
    return j;
  } catch (e) {
    console.warn(`[public-bot] ${method} error: ${e?.name || 'unknown'}`);
    return null;
  } finally { clearTimeout(t); }
}

export async function registerPublicWebhook() {
  if (!publicToken()) return;
  const base = String(process.env.PUBLIC_BACKEND_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
  if (!base.startsWith('https://')) {
    console.warn('[public-bot] Set PUBLIC_BACKEND_URL (https) so the public bot can receive messages.');
    return;
  }
  const r = await api('setWebhook', {
    url: `${base}/api/telegram/public-webhook`, secret_token: publicWebhookSecret(),
    allowed_updates: ['message', 'callback_query'], drop_pending_updates: false,
  });
  if (r?.ok) console.log('[public-bot] webhook registered');
  await api('setMyCommands', { commands: [
    { command: 'start', description: 'How to check a user' },
    { command: 'cancel', description: 'Cancel a report' },
  ] });
}

// ---- small helpers ------------------------------------------------------------
const nrp = (n) => `NRP ${Number(n || 0).toLocaleString('en-US')}`;
const say = (chat_id, text, reply_markup) =>
  api('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(reply_markup ? { reply_markup } : {}) });

const maskOn = () => process.env.PUBLIC_BOT_MASK_CONTACT === '1';
const maskEmail = (e) => { const [a, b] = String(e).split('@'); return b ? `${a.slice(0, 2)}${'*'.repeat(Math.max(2, a.length - 2))}@${b}` : e; };
const maskPhone = (p) => { const s = String(p); return s.length > 5 ? `${s.slice(0, 3)}${'*'.repeat(s.length - 5)}${s.slice(-2)}` : s; };

const LONG = '_'.repeat(50);
const SHORT = '_'.repeat(25);

export function buildDetails(uid, d) {
  const ban = activeBan(d);
  const phone = d.profilePhone || '';
  const email = d.email || '';
  const rows = [
    ['Name', d.profileName || '—'],
    ['Number', phone ? (maskOn() ? maskPhone(phone) : phone) : '—'],
    ['Email', email ? (maskOn() ? maskEmail(email) : email) : '—'],
    ['Role', ROLE_LABEL[d.role || 'user'] || String(d.role).toUpperCase()],
    ['Total spend', nrp(totalLoaded(d))],
    ['Available balance', nrp(d.balance)],
    ['Key bought', String(Number(d.totalKeysBought || 0))],
    ['Spend money', nrp(d.totalSpent)],
    ['Account status', ban ? `BANNED (${ban.label})` : (d.requestStatus || 'Active')],
  ];
  const lines = [LONG, '<b>SRT X CHEATS USER DETAILS</b>', SHORT];
  for (const [k, v] of rows) lines.push(`${k} - <b>${esc(v)}</b>`, SHORT);
  lines[lines.length - 1] = LONG;
  return lines.join('\n');
}

// ---- state + limits -----------------------------------------------------------
const pending = new Map();           // tok -> { uid, d(snapshot for report), by, exp }
const reporting = new Map();         // telegram user id -> { tok data, exp }
const hits = new Map();              // telegram user id -> [timestamps]
const REPORT_TTL = 10 * 60_000, VIEW_TTL = 30 * 60_000;

function sweep() {
  const now = Date.now();
  for (const [k, v] of pending) if (v.exp < now) pending.delete(k);
  for (const [k, v] of reporting) if (v.exp < now) reporting.delete(k);
  if (hits.size > 5000) hits.clear();
}
function allow(userId, bucket, max, windowMs) {
  const key = `${bucket}:${userId}`, now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return false; }
  arr.push(now); hits.set(key, arr);
  return true;
}

const INTRO =
  '👋 <b>SRT X CHEATS — user check</b>\n' +
  'Send a reseller\'s <b>phone number</b>, <b>e-mail</b> or <b>UID</b> and I will show their account details.\n' +
  'You can report a reseller from the result with the Report button.';

// ---- updates -------------------------------------------------------------------
export async function handleUpdate(u) {
  sweep();
  if (u?.message) return onMessage(u.message);
  if (u?.callback_query) return onCallback(u.callback_query);
}

async function onMessage(msg) {
  if (msg.chat?.type !== 'private') return;           // only private chats - no spam in groups
  const chat = msg.chat.id, uid = msg.from?.id;
  const text = String(msg.text || '').trim();
  if (!text || !uid) return;

  if (/^\/(start|help)(@\w+)?$/i.test(text)) { reporting.delete(uid); return void (await say(chat, INTRO)); }
  if (/^\/cancel(@\w+)?$/i.test(text)) {
    const had = reporting.delete(uid);
    return void (await say(chat, had ? '❎ Report cancelled.' : 'Nothing to cancel.'));
  }
  if (text.startsWith('/')) return;

  const rep = reporting.get(uid);
  if (rep && rep.exp > Date.now()) return saveReport(msg, rep);

  if (!allow(uid, 'lookup', 10, 60_000)) return void (await say(chat, '⏳ Too many checks. Please wait a minute and try again.'));
  const idf = text.replace(/^(number|phone|email|e-mail|gmail|uid|id)\s*[-:=]\s*/i, '').trim();
  let found;
  try { found = await findUserByAny(idf); } catch (e) {
    console.warn('[public-bot] lookup failed:', e?.message || e);
    return void (await say(chat, '⚠️ Could not check right now. Please try again in a moment.'));
  }
  if (!found) return void (await say(chat, '❌ No user found. Send the phone number, e-mail or UID exactly as registered.'));

  const tok = crypto.randomBytes(6).toString('hex');
  pending.set(tok, { uid: found.uid, name: found.data.profileName || '', email: found.data.email || '', phone: found.data.profilePhone || '', by: uid, exp: Date.now() + VIEW_TTL });
  await say(chat, buildDetails(found.uid, found.data), {
    inline_keyboard: [[{ text: 'Report', callback_data: `rp:${tok}` }, { text: 'Ok', callback_data: `ok:${tok}` }]],
  });
}

async function onCallback(cb) {
  const m = String(cb.data || '').match(/^(rp|ok):([a-f0-9]{12})$/);
  if (!m) return void (await api('answerCallbackQuery', { callback_query_id: cb.id }));
  const [, action, tok] = m;
  const chat = cb.message?.chat?.id, mid = cb.message?.message_id;
  const p = pending.get(tok);
  if (!p || p.by !== cb.from?.id) {
    return void (await api('answerCallbackQuery', { callback_query_id: cb.id, text: 'Expired — send the details again.', show_alert: true }));
  }
  if (action === 'ok') {
    pending.delete(tok);
    await api('answerCallbackQuery', { callback_query_id: cb.id });
    return void (await api('editMessageReplyMarkup', { chat_id: chat, message_id: mid, reply_markup: { inline_keyboard: [] } }));
  }
  // report
  if (!allow(cb.from.id, 'report', 3, 60 * 60_000)) {
    return void (await api('answerCallbackQuery', { callback_query_id: cb.id, text: 'Report limit reached (3 per hour). Try later.', show_alert: true }));
  }
  reporting.set(cb.from.id, { ...p, tok, exp: Date.now() + REPORT_TTL });
  await api('answerCallbackQuery', { callback_query_id: cb.id });
  await say(chat, '📝 <b>Type your report about this reseller</b> and send it now.\n(What happened, when, any proof/number. Send /cancel to stop.)');
}

async function saveReport(msg, rep) {
  const chat = msg.chat.id, from = msg.from;
  const text = String(msg.text || '').trim();
  if (text.length < 10) return void (await say(chat, 'Please write a bit more (at least 10 characters), or /cancel.'));
  const body = text.slice(0, 1000);
  reporting.delete(from.id);
  const rec = {
    targetUid: rep.uid, targetName: rep.name, targetEmail: rep.email, targetPhone: rep.phone,
    reporterTgId: from.id, reporterUsername: from.username || '', reporterName: [from.first_name, from.last_name].filter(Boolean).join(' '),
    text: body, createdAt: new Date().toISOString(), status: 'open',
  };
  let id = '';
  try { id = (await db().collection('resellerReports').add(rec)).id; } catch (e) { console.warn('[public-bot] could not store report:', e?.message || e); }
  const alert =
    `🚩 <b>RESELLER REPORT</b>${id ? ` <code>${esc(id)}</code>` : ''}\n` +
    `Reported: <b>${esc(rep.name || '—')}</b>\n✉️ ${esc(rep.email || '—')}\n📱 ${esc(rep.phone || '—')}\n🆔 <code>${esc(rep.uid)}</code>\n` +
    `_________________________\n📝 ${esc(body)}\n_________________________\n` +
    `By: ${esc(rec.reporterName || '—')}${from.username ? ` (@${esc(from.username)})` : ''} · <code>${from.id}</code>\n📅 ${esc(formatNepaliDateTime())}`;
  // to the private admin bot's chat; if that bot is not configured, to the report/general alert bot
  const ids = adminChatIds();
  let sent = false;
  if (process.env.TELEGRAM_TOPUP_AUTO_BOT && ids.length) {
    const res = await Promise.all(ids.map((c) => privateTg('sendMessage', { chat_id: c, text: alert, parse_mode: 'HTML', disable_web_page_preview: true })));
    sent = res.some((r) => r?.ok);
  }
  if (!sent) sent = (await telegramNotify(alert, 'report')).length === 0;
  await say(chat, sent || id ? '✅ Your report was sent to the admins. Thank you.' : '⚠️ Could not send your report right now. Please try again later.');
}
