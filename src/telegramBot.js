// src/telegramBot.js — admin slash-commands on the top-up bot.
//
//   /addbalance   bot: "send user UID or email"  -> amount -> [Confirm ✅]/[Cancel ❌]
//   /getdetail    bot: "send user UID or email"  -> user details
//   /mode         bot: "send user UID or email"  -> [User] [Reseller] [Pro Reseller]
//   /cancel       forget the current command
//
// Same security as the Load/Cancel buttons: only the configured chat(s)
// (TELEGRAM_TOPUP_AUTO_CHAT_ID) and, when set, only TELEGRAM_TOPUP_ADMIN_IDS.
// Conversation state is kept in memory for 5 minutes (a Render restart just
// means "send the command again").
import { tg, chatIds, adminIds, newReqId, answerCallback, editMessage } from './topupQr.js';
import { findUser, creditUser, setUserRole, userDetailText, MAX_BOT_LOAD } from './adminOps.js';
import { proPublicState, normalizeRole, ROLE_LABEL } from './proTier.js';
import { announceProActivated } from './proReseller.js';
import { esc } from './telegram.js';

const TTL = 5 * 60_000;
const sessions = new Map(); // `${chat}:${user}` -> { cmd, step, uid?, exp }
const pending = new Map();  // token -> { kind, uid, amount?, by, exp }
const nrp = (n) => `NRP ${Number(n || 0).toLocaleString('en-US')}`;

function sweep() {
  const now = Date.now();
  for (const [k, v] of sessions) if (v.exp < now) sessions.delete(k);
  for (const [k, v] of pending) if (v.exp < now) pending.delete(k);
}

export function isAllowedMessage(msg) {
  const chat = msg?.chat?.id;
  if (!chat || !chatIds().map(String).includes(String(chat))) return false;
  const allow = adminIds();
  return allow.length === 0 || allow.includes(String(msg.from?.id));
}

const say = (chat_id, text, reply_markup) =>
  tg('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(reply_markup ? { reply_markup } : {}) });
const who = (from) => (from?.username ? `@${from.username}` : String(from?.first_name || from?.id || 'admin'));

const HELP =
  '🤖 <b>Admin commands</b>\n' +
  '/addbalance — add balance to a user\n' +
  '/getdetail — get a user\'s details\n' +
  '/mode — change mode (user / reseller / pro reseller)\n' +
  '/cancel — cancel current command';

export async function handleMessage(msg) {
  if (!isAllowedMessage(msg)) return;
  const text = String(msg.text || '').trim();
  if (!text) return;
  sweep();
  const chat = msg.chat.id;
  const key = `${chat}:${msg.from?.id}`;

  const m = text.match(/^\/(\w+)(?:@\w+)?(?:\s+([\s\S]+))?$/);
  if (m) {
    const cmd = m[1].toLowerCase();
    const arg = (m[2] || '').trim();
    if (cmd === 'start' || cmd === 'help') return void (await say(chat, HELP));
    if (cmd === 'cancel') { sessions.delete(key); return void (await say(chat, '❎ Cancelled.')); }
    if (!['addbalance', 'getdetail', 'mode'].includes(cmd)) return;
    sessions.set(key, { cmd, step: 'identify', exp: Date.now() + TTL });
    if (arg) return identify(chat, key, arg);               // "/getdetail someone@gmail.com"
    return void (await say(chat, 'Send user UID or email ✉️'));
  }

  const st = sessions.get(key);
  if (!st || st.exp < Date.now()) return;                   // ordinary chatter — ignore
  if (st.step === 'identify') return identify(chat, key, text);
  if (st.step === 'amount') return amountStep(chat, key, st, text);
}

async function identify(chat, key, idf) {
  const st = sessions.get(key);
  const u = await findUser(idf);
  if (!u) return void (await say(chat, '❌ No user found with that UID / email. Send another one, or /cancel.'));

  if (st.cmd === 'getdetail') {
    sessions.delete(key);
    return void (await say(chat, userDetailText(u.uid, u.data)));
  }

  if (st.cmd === 'addbalance') {
    sessions.set(key, { ...st, step: 'amount', uid: u.uid, exp: Date.now() + TTL });
    const pro = proPublicState(u.data);
    const hint = pro.status === 'approved'
      ? `\n💎 Pro Reseller pending activation — new top-up ${nrp(pro.deposited)} / ${nrp(pro.required)}` : '';
    return void (await say(chat,
      `👤 <b>${esc(u.data.profileName || '—')}</b> · ${esc(u.data.email || '—')}\n🆔 <code>${esc(u.uid)}</code>\n` +
      `💰 Balance: <b>${esc(nrp(u.data.balance))}</b>${hint}\n\nSend amount to add (NRP) 💵`));
  }

  // mode
  sessions.delete(key);
  const tok = newReqId();
  pending.set(tok, { kind: 'mode', uid: u.uid, by: key, exp: Date.now() + TTL });
  const cur = u.data.role || 'user';
  return void (await say(chat,
    `👤 <b>${esc(u.data.profileName || '—')}</b> · ${esc(u.data.email || '—')}\n🆔 <code>${esc(u.uid)}</code>\n` +
    `Current mode: <b>${esc(ROLE_LABEL[cur] || cur)}</b>\n\nChoose the new mode:`,
    { inline_keyboard: [[
      { text: '👤 User', callback_data: `md:u:${tok}` },
      { text: '🛒 Reseller', callback_data: `md:r:${tok}` },
      { text: '💎 Pro Reseller', callback_data: `md:p:${tok}` },
    ]] }));
}

async function amountStep(chat, key, st, text) {
  const amount = Number(text.replace(/[, ]/g, '').replace(/^nrp/i, ''));
  if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_BOT_LOAD) {
    return void (await say(chat, `Send a whole number between 1 and ${MAX_BOT_LOAD}, or /cancel.`));
  }
  sessions.delete(key);
  const tok = newReqId();
  pending.set(tok, { kind: 'add', uid: st.uid, amount, by: key, exp: Date.now() + TTL });
  await say(chat, `Add <b>${esc(nrp(amount))}</b> to <code>${esc(st.uid)}</code>?`, {
    inline_keyboard: [[{ text: 'Confirm ✅', callback_data: `ab:Y:${tok}` }, { text: 'Cancel ❌', callback_data: `ab:N:${tok}` }]],
  });
}

/** Buttons from /addbalance (ab:) and /mode (md:). Authorisation is checked by the caller. */
export async function handleBotCallback(cb) {
  sweep();
  const m = String(cb.data).match(/^(ab:[YN]|md:[urp]):([a-f0-9]{12})$/);
  if (!m) return answerCallback(cb.id, 'Unknown action');
  const [action, tok] = [m[1], m[2]];
  const p = pending.get(tok);
  const chat = cb.message?.chat?.id, mid = cb.message?.message_id;
  if (!p) {
    await answerCallback(cb.id, 'Expired — send the command again', true);
    return editMessage(chat, mid, `${esc(cb.message?.text || '')}\n\n⌛ Expired`);
  }
  pending.delete(tok); // one press only
  const by = `telegram:${cb.from?.id}`;
  const base = esc(cb.message?.text || '');

  try {
    if (action === 'ab:N') {
      await answerCallback(cb.id, 'Cancelled');
      return editMessage(chat, mid, `${base}\n\n❌ <b>Cancelled</b> by ${esc(who(cb.from))}`);
    }
    if (action === 'ab:Y') {
      const r = await creditUser(p.uid, p.amount, { note: `Telegram /addbalance by ${who(cb.from)}`, actor: 'TELEGRAM', by });
      await answerCallback(cb.id, `Loaded ${nrp(p.amount)}`);
      await editMessage(chat, mid, `${base}\n\n✅ <b>LOADED</b> by ${esc(who(cb.from))}\n${esc(nrp(r.before))} ➝ <b>${esc(nrp(r.after))}</b>` +
        (r.proActivated ? '\n💎 <b>PRO RESELLER ACTIVATED</b> (new top-up reached the requirement)' : ''));
      if (r.proActivated) announceProActivated({ uid: p.uid, email: r.email, name: r.name, deposited: r.deposited });
      return;
    }
    // md:u / md:r / md:p
    const role = normalizeRole(action.slice(3));
    const r = await setUserRole(p.uid, role, by);
    await answerCallback(cb.id, `Mode → ${ROLE_LABEL[role]}`);
    return editMessage(chat, mid, `${base}\n\n✅ <b>MODE CHANGED</b> by ${esc(who(cb.from))}\n${esc(ROLE_LABEL[r.from] || r.from)} ➝ <b>${esc(ROLE_LABEL[role])}</b>`);
  } catch (e) {
    await answerCallback(cb.id, `Failed: ${String(e.message).slice(0, 150)}`, true);
    return editMessage(chat, mid, `${base}\n\n⚠️ <b>Failed:</b> ${esc(e.message)}`);
  }
}
