// src by SRT X CHEATS. Copy right SRT X CHEATS
// DEPOSIT bot - every user can top up from Telegram ("Deposit via Telegram" on the website).
//   website  -> POST /api/user/telegram-deposit-link  -> https://t.me/<bot>?start=dep_<one-time token>
//   bot      -> shows the user's details (Uid / Email / Name / Number) + the store QR
//   user     -> sends the amount -> sends the eSewa transaction code
//   bot      -> creates the same QR top-up request as the website, the admin bot gets Load / Cancel buttons
// Env: TELEGRAM_DEPOSIT_BOT_TOKEN (required), PUBLIC_BACKEND_URL (https, webhook),
//      SITE_URL (where /assets/img/srtx-pay-qr.jpg is served, default https://www.srtxcheats.com),
//      TELEGRAM_DEPOSIT_WEBHOOK_SECRET (optional), DEPOSIT_QR_URL (optional, full URL of the QR image).
import crypto from 'node:crypto';
import { db } from './firebase.js';
import { esc } from './telegram.js';
import { createQrTopup, QR_MIN_AMOUNT, QR_MAX_AMOUNT } from './topupQr.js';

export const depositToken = () => process.env.TELEGRAM_DEPOSIT_BOT_TOKEN || '';
export const depositBotConfigured = () => !!depositToken();
export function depositWebhookSecret() {
  return process.env.TELEGRAM_DEPOSIT_WEBHOOK_SECRET
    || crypto.createHmac('sha256', depositToken() || 'unset').update('deposit-webhook').digest('hex').slice(0, 48);
}

async function api(method, body) {
  const token = depositToken();
  if (!token) return null;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) console.warn(`[deposit-bot] ${method} failed: ${j.description || r.status}`);
    return j;
  } catch (e) {
    console.warn(`[deposit-bot] ${method} error: ${e?.name || 'unknown'}`);
    return null;
  } finally { clearTimeout(t); }
}

const say = (chat_id, text, extra = {}) =>
  api('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });

// Used by the admin bot to tell the user when the top-up was loaded / cancelled
export async function notifyDepositUser(chatId, text) {
  if (!chatId || !depositToken()) return;
  try { await say(chatId, text); } catch (_) {}
}

export async function registerDepositWebhook() {
  if (!depositToken()) return;
  const base = String(process.env.PUBLIC_BACKEND_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
  if (!base.startsWith('https://')) {
    console.warn('[deposit-bot] Set PUBLIC_BACKEND_URL (https) so the deposit bot can receive messages.');
    return;
  }
  const r = await api('setWebhook', {
    url: `${base}/api/telegram/deposit-webhook`, secret_token: depositWebhookSecret(),
    allowed_updates: ['message'], drop_pending_updates: false,
  });
  if (r?.ok) console.log('[deposit-bot] webhook registered');
  await api('setMyCommands', { commands: [
    { command: 'start', description: 'Start a deposit (open it from the website)' },
    { command: 'cancel', description: 'Cancel the current deposit' },
  ] });
}

// ---- deep link -----------------------------------------------------------------
const LINK_TTL = 15 * 60_000;          // the link on the website stays valid for 15 minutes
const SESSION_TTL = 30 * 60_000;       // after pressing Start the user has 30 minutes to finish

let cachedUsername = '';
async function botUsername() {
  if (process.env.TELEGRAM_DEPOSIT_BOT_USERNAME) return process.env.TELEGRAM_DEPOSIT_BOT_USERNAME.replace(/^@/, '');
  if (cachedUsername) return cachedUsername;
  const r = await api('getMe', {});
  cachedUsername = r?.result?.username || '';
  return cachedUsername;
}

// one-time token bound to the logged-in account (nobody can start a deposit for somebody else's UID)
export async function createDepositLink(uid) {
  const name = await botUsername();
  if (!name) return '';
  const token = crypto.randomBytes(9).toString('base64url');          // 12 chars, [A-Za-z0-9_-]
  await db().collection('tgDepositLinks').doc(token).set({ uid, exp: Date.now() + LINK_TTL });
  return `https://t.me/${name}?start=dep_${token}`;
}

// ---- helpers ---------------------------------------------------------------------
const LONG = '_'.repeat(25);
const nrp = (n) => `NRP ${Number(n || 0).toLocaleString('en-US')}`;
const sessions = () => db().collection('tgDepositSessions');
const hits = new Map();
function allow(id, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(id) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(id, arr); return false; }
  arr.push(now); hits.set(id, arr);
  if (hits.size > 5000) hits.clear();
  return true;
}

const qrUrl = () => process.env.DEPOSIT_QR_URL
  || `${String(process.env.SITE_URL || 'https://www.srtxcheats.com').replace(/\/+$/, '')}/assets/img/srtx-pay-qr.jpg`;

const INTRO =
  '👋 <b>SRT X CHEATS — Deposit bot</b>\n' +
  'To add balance, open the website → <b>Add Balance</b> → <b>Deposit via Telegram</b>.\n' +
  'That link connects this chat to your account safely.';

function detailsCard(uid, d) {
  const v = (x) => esc(x || 'Not set');
  return [
    LONG,
    `Uid - ${esc(uid)}`,
    `Email - ${v(d.email)}`,
    `Name - ${v(d.profileName)}`,
    `Number - ${v(d.profilePhone)}`,
    LONG,
    'I want to get deposit balance',
    LONG,
  ].join('\n');
}

const ASK_AMOUNT = `Enter amount of deposit\n(min ${nrp(QR_MIN_AMOUNT)})`;
const askTx = (amount) =>
  `Send transaction code\n\nExample - <code>1U7HMDY</code>\n\nOnly on - <b>Esewa</b>\n${LONG}\n` +
  `Pay current amount: <b>${esc(nrp(amount))}</b>\nWrong amount = no refunds 😕`;

// ---- updates ---------------------------------------------------------------------
export async function handleDepositUpdate(u) {
  const msg = u?.message;
  if (!msg || msg.chat?.type !== 'private' || !msg.from?.id) return;     // private chats only
  const chat = msg.chat.id, tgId = String(msg.from.id);
  const text = String(msg.text || '').trim();
  if (!text) return;
  if (!allow(`m:${tgId}`, 30, 60_000)) return void (await say(chat, '⏳ Too many messages. Please wait a minute.'));

  const start = text.match(/^\/start(?:@\w+)?(?:\s+dep_([A-Za-z0-9_-]{6,32}))?$/i);
  if (start) return start[1] ? onStartLink(chat, tgId, start[1]) : void (await say(chat, INTRO));
  if (/^\/cancel(@\w+)?$/i.test(text)) {
    await sessions().doc(tgId).delete().catch(() => {});
    return void (await say(chat, '❎ Deposit cancelled. Open the website to start a new one.'));
  }
  if (text.startsWith('/')) return void (await say(chat, INTRO));

  const snap = await sessions().doc(tgId).get();
  const s = snap.exists ? snap.data() : null;
  if (!s || s.exp < Date.now()) {
    if (s) await sessions().doc(tgId).delete().catch(() => {});
    return void (await say(chat, '⌛ Session expired.\n' + INTRO));
  }
  if (s.step === 'amount') return onAmount(chat, tgId, s, text);
  if (s.step === 'tx') return onTx(chat, tgId, s, text);
}

async function onStartLink(chat, tgId, token) {
  const ref = db().collection('tgDepositLinks').doc(token);
  const snap = await ref.get();
  const l = snap.exists ? snap.data() : null;
  if (!l || l.exp < Date.now()) return void (await say(chat, '❌ This link expired. Open the website → Add Balance → <b>Deposit via Telegram</b> again.'));
  await ref.delete().catch(() => {});                                     // one-time link

  const us = await db().collection('users').doc(l.uid).get();
  if (!us.exists) return void (await say(chat, '❌ Account not found. Please log in on the website and try again.'));
  const d = us.data();
  if (d.banned || d.ban) return void (await say(chat, '⛔ This account cannot deposit right now. Contact support.'));

  await sessions().doc(tgId).set({ uid: l.uid, step: 'amount', exp: Date.now() + SESSION_TTL, chat });
  // the "pre-typed" message with the user's own details
  await say(chat, detailsCard(l.uid, d));
  // store QR + welcome + amount question
  const caption = `Welcome to SRT X CHEATS\n${LONG}\n${ASK_AMOUNT}`;
  const photo = await api('sendPhoto', { chat_id: chat, photo: qrUrl(), caption });
  if (!photo?.ok) await say(chat, `Welcome to SRT X CHEATS\n(Could not load the QR here — open the website QR page.)\n${LONG}\n${ASK_AMOUNT}`);
}

async function onAmount(chat, tgId, s, text) {
  const digits = text.replace(/[,\s]/g, '').replace(/^(nrp|rs\.?|npr)/i, '');
  const amount = /^\d{1,7}$/.test(digits) ? Number(digits) : NaN;
  if (!Number.isInteger(amount) || amount < QR_MIN_AMOUNT || amount > QR_MAX_AMOUNT) {
    return void (await say(chat, `❌ Send a valid amount (${nrp(QR_MIN_AMOUNT)} – ${nrp(QR_MAX_AMOUNT)}), numbers only.\n${ASK_AMOUNT}`));
  }
  await sessions().doc(tgId).set({ ...s, step: 'tx', amount, exp: Date.now() + SESSION_TTL });
  await say(chat, askTx(amount));
}

async function onTx(chat, tgId, s, text) {
  const txCode = text.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z0-9_-]{6,40}$/.test(txCode)) {
    return void (await say(chat, '❌ Invalid transaction code. Send only the code.\n\nExample - <code>1U7HMDY</code>\nOnly on - <b>Esewa</b>'));
  }
  if (!allow(`d:${tgId}`, 8, 10 * 60_000)) return void (await say(chat, '⏳ Too many attempts. Please wait a few minutes.'));
  const r = await createQrTopup({
    uid: s.uid, amount: s.amount, txCode, source: 'telegram', extraIndex: { tgChatId: String(chat), tgUserId: tgId },
  });
  if (!r.ok) return void (await say(chat, `❌ ${esc(r.error)}`));
  await sessions().doc(tgId).delete().catch(() => {});
  await say(chat,
    `✅ <b>Request received</b>\nAmount: <b>${esc(nrp(s.amount))}</b>\nTx code: <code>${esc(txCode)}</code>\n${LONG}\n` +
    'We are checking your payment. Your balance will be loaded soon and I will message you here.');
}
