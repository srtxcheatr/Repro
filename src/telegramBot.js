// src by SRT X CHEATS. Copy right SRT X CHEATS
// Private admin bot.
//   /addbalance /cutbalance /alluserbalance /allrevenue /allusers_list /product_info
//   /ban /unban /annulment /getdetail /mode /notifytest /cancel
import { tg, chatIds, adminIds, newReqId, answerCallback, editMessage } from './topupQr.js';
import {
  findUserByAny, creditUser, debitUser, banUser, unbanUser, annulPurchase, recentPurchases,
  userBalanceReport, activeUsersReport, revenueReport, setUserRole, userDetailText, MAX_BOT_LOAD,
} from './adminOps.js';
import { activeBan, BAN_DURATIONS } from './ban.js';
import { proPublicState, normalizeRole, ROLE_LABEL } from './proTier.js';
import { announceProActivated } from './proReseller.js';
import { searchProducts, cleanQuery, formatGroups } from './productInfo.js';
import { esc, telegramNotify, testNotify, notifyFailures, NOTIFY_PURPOSES, describeTarget } from './telegram.js';

const TTL = 5 * 60_000;
const sessions = new Map();
const pending = new Map();
const nrp = (n) => `NRP ${Number(n || 0).toLocaleString('en-US')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_LIST_MESSAGES = 40;

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

// Splits blocks of text into messages that fit Telegram's 4096 limit and sends them one by one.
export function chunkBlocks(header, blocks, max = 3800) {
  const chunks = [];
  let cur = header;
  for (const b of blocks) {
    if (cur && (cur.length + b.length + 2) > max) { chunks.push(cur); cur = ''; }
    cur += (cur ? '\n\n' : '') + b;
  }
  if (cur) chunks.push(cur);
  return chunks;
}
async function sayMany(chat, chunks, footerIfCut = '') {
  const shown = chunks.slice(0, MAX_LIST_MESSAGES);
  for (const c of shown) { await say(chat, c); if (shown.length > 1) await sleep(450); }
  if (chunks.length > shown.length && footerIfCut) await say(chat, footerIfCut);
}

const HELP =
  '🤖 <b>Admin commands</b>\n' +
  '/addbalance — add balance to a user\n' +
  '/cutbalance — cut (deduct) balance from a user\n' +
  '/alluserbalance — total balance + every user who holds a balance\n' +
  '/allusers_list — every user who loaded balance or bought keys\n' +
  '/allrevenue — total revenue, keys sold, balance held\n' +
  '/product_info — prices of a product (any part of the name works)\n' +
  '/ban — ban a user (1h … permanent)\n' +
  '/unban — remove a ban\n' +
  '/annulment — cancel a purchase and refund it\n' +
  '/getdetail — get a user\'s details\n' +
  '/mode — change mode (user / reseller / pro reseller)\n' +
  '/notifytest — test that every alert bot can reach you\n' +
  '/cancel — cancel current command\n\n' +
  'A user can be found by UID, e-mail or phone number.';

// command name (underscores removed, lower case) -> canonical name
const ALIASES = { alluserlist: 'alluserslist', allusers: 'alluserslist', userlist: 'alluserslist', allbalance: 'alluserbalance', revenue: 'allrevenue', products: 'productinfo', product: 'productinfo' };
const USER_CMDS = ['addbalance', 'cutbalance', 'getdetail', 'mode', 'ban', 'unban', 'annulment'];

export async function handleMessage(msg) {
  if (!isAllowedMessage(msg)) return;
  const text = String(msg.text || '').trim();
  if (!text) return;
  sweep();
  const chat = msg.chat.id;
  const key = `${chat}:${msg.from?.id}`;

  const m = text.match(/^\/(\w+)(?:@\w+)?(?:\s+([\s\S]+))?$/);
  if (m) {
    let cmd = m[1].toLowerCase().replace(/_/g, '');
    cmd = ALIASES[cmd] || cmd;
    const arg = (m[2] || '').trim();
    if (cmd === 'start' || cmd === 'help') return void (await say(chat, HELP));
    if (cmd === 'cancel') { sessions.delete(key); return void (await say(chat, '❎ Cancelled.')); }
    if (cmd === 'alluserbalance') { sessions.delete(key); return reportBalances(chat); }
    if (cmd === 'alluserslist') { sessions.delete(key); return reportActiveUsers(chat); }
    if (cmd === 'allrevenue') { sessions.delete(key); return reportRevenue(chat); }
    if (cmd === 'notifytest') { sessions.delete(key); return notifyTest(chat, arg); }
    if (cmd === 'productinfo') {
      if (arg) { sessions.delete(key); return productInfo(chat, arg); }
      sessions.set(key, { cmd, step: 'product', exp: Date.now() + TTL });
      return void (await say(chat, 'Send the product name 📦 (any part of it works, e.g. <code>PHANTOM</code>)'));
    }
    if (!USER_CMDS.includes(cmd)) return;
    sessions.set(key, { cmd, step: 'identify', exp: Date.now() + TTL });
    if (arg) return identify(chat, key, arg);
    return void (await say(chat, 'Send user UID, e-mail or number ✉️'));
  }

  const st = sessions.get(key);
  if (!st || st.exp < Date.now()) return;
  if (st.step === 'product') { sessions.delete(key); return productInfo(chat, text); }
  if (st.step === 'identify') return identify(chat, key, text);
  if (st.step === 'amount') return amountStep(chat, key, st, text);
}

// ---- reports --------------------------------------------------------------
const roleTag = (r) => ROLE_LABEL[r] || String(r || 'user').toUpperCase();
const contact = (r) => `✉️ ${esc(r.email || '—')} · 📱 ${esc(r.whatsapp || '—')}`;

async function reportBalances(chat) {
  try {
    const { total, rows, registered } = await userBalanceReport();
    const header = `💰 <b>ALL USER BALANCE</b>\nTotal balance: <b>${esc(nrp(total))}</b>\nUsers holding balance: <b>${rows.length}</b> (of ${registered} registered)\nUsers with NRP 0 are not listed.`;
    if (!rows.length) return void (await say(chat, `${header}\n\nNo user has any balance right now.`));
    const blocks = rows.map((r, i) => `${i + 1}. <b>${esc(r.name)}</b> — <b>${esc(nrp(r.balance))}</b>\n   ${contact(r)} · ${esc(roleTag(r.role))}\n   🆔 <code>${esc(r.uid)}</code>`);
    await sayMany(chat, chunkBlocks(header, blocks), `…list cut after ${MAX_LIST_MESSAGES} messages (${rows.length} users). Use the admin panel for the rest.`);
  } catch (e) { await say(chat, `⚠️ <b>Failed:</b> ${esc(e.message)}`); }
}

async function reportActiveUsers(chat) {
  try {
    const { rows, registered } = await activeUsersReport();
    const header = `👥 <b>ALL USERS LIST</b>\nUsers who loaded balance or bought keys: <b>${rows.length}</b> (of ${registered} registered)\nUsers with no deposit and no balance are not listed.`;
    if (!rows.length) return void (await say(chat, `${header}\n\nNobody yet.`));
    const blocks = rows.map((r, i) => `${i + 1}. <b>${esc(r.name)}</b> · ${esc(roleTag(r.role))}\n   ${contact(r)}\n   💰 ${esc(nrp(r.balance))} · 🛒 spent ${esc(nrp(r.totalSpent))} · 🔑 ${r.totalKeysBought} keys\n   🆔 <code>${esc(r.uid)}</code>`);
    await sayMany(chat, chunkBlocks(header, blocks), `…list cut after ${MAX_LIST_MESSAGES} messages (${rows.length} users). Use the admin panel for the rest.`);
  } catch (e) { await say(chat, `⚠️ <b>Failed:</b> ${esc(e.message)}`); }
}

async function reportRevenue(chat) {
  try {
    const r = await revenueReport();
    const line = (k, label) => `${label}: ${r.by[k].n} users · ${esc(nrp(r.by[k].revenue))}`;
    await say(chat,
      `📈 <b>ALL REVENUE</b>\n` +
      `Total revenue (keys sold): <b>${esc(nrp(r.revenue))}</b>\n` +
      `Keys sold: <b>${r.keys}</b>\n` +
      `Paying users: <b>${r.payers}</b> of ${r.registered} registered\n` +
      `Balance held by users (not spent yet): <b>${esc(nrp(r.balance))}</b>\n` +
      `_________________________\n` +
      `${line('user', 'USER')}\n${line('reseller', 'RESELLER')}\n${line('pro_reseller', 'PRO RESELLER')}`);
  } catch (e) { await say(chat, `⚠️ <b>Failed:</b> ${esc(e.message)}`); }
}

async function productInfo(chat, raw) {
  const q = cleanQuery(raw);
  if (!q) return void (await say(chat, 'Send a product name, e.g. <code>/product_info PHANTOM</code>'));
  try {
    const groups = await searchProducts(q);
    if (!groups.length) return void (await say(chat, `❌ No product found for “${esc(q)}”. Try a shorter part of the name.`));
    const chunks = chunkBlocks(`🔎 <b>${groups.length}</b> product${groups.length > 1 ? 's' : ''} for “${esc(q)}”`, formatGroups(groups));
    await sayMany(chat, chunks, '…more results not shown — send a longer name to narrow it down.');
  } catch (e) { await say(chat, `⚠️ <b>Failed:</b> ${esc(e.message)}`); }
}

async function notifyTest(chat, arg) {
  const wanted = arg ? [arg.toLowerCase()].filter((p) => NOTIFY_PURPOSES.includes(p)) : NOTIFY_PURPOSES;
  if (!wanted.length) return void (await say(chat, `Unknown bot. Use one of: ${NOTIFY_PURPOSES.join(', ')}`));
  await say(chat, '🔧 Testing alert bots… each working one sends you a test message.');
  const seen = new Map();
  const lines = [];
  for (const p of wanted) {
    const target = describeTarget(p);
    if (target && seen.has(target)) { lines.push(`↪️ <b>${esc(p)}</b> — same bot + chat as <b>${esc(seen.get(target))}</b>`); continue; }
    const r = await testNotify(p);
    if (target) seen.set(target, p);
    lines.push(`${r.ok ? '✅' : '❌'} <b>${esc(p)}</b> — ${esc(r.detail)}${r.tokenFrom ? ` <i>(${esc(r.tokenFrom)})</i>` : ''}`);
  }
  const recent = notifyFailures().slice(0, 5);
  if (recent.length) lines.push('', '<b>Recent failed alerts</b>', ...recent.map((f) => `• ${esc(f.at.slice(11, 19))} ${esc(f.purpose)} → ${esc(f.reason)}`));
  await say(chat, lines.join('\n'));
}

// ---- per-user flows ---------------------------------------------------------
const head = (u) => `👤 <b>${esc(u.data.profileName || '—')}</b> · ${esc(u.data.email || '—')}\n🆔 <code>${esc(u.uid)}</code>`;

async function identify(chat, key, idf) {
  const st = sessions.get(key);
  let u;
  try { u = await findUserByAny(idf); } catch (e) { return void (await say(chat, `⚠️ <b>Failed:</b> ${esc(e.message)}`)); }
  if (!u) return void (await say(chat, '❌ No user found with that UID / e-mail / number. Send another one, or /cancel.'));

  if (st.cmd === 'getdetail') {
    sessions.delete(key);
    return void (await say(chat, userDetailText(u.uid, u.data)));
  }

  if (st.cmd === 'addbalance' || st.cmd === 'cutbalance') {
    sessions.set(key, { ...st, step: 'amount', uid: u.uid, exp: Date.now() + TTL });
    const pro = proPublicState(u.data);
    const hint = st.cmd === 'addbalance' && pro.status === 'approved'
      ? `\n💎 Pro Reseller pending activation — new top-up ${nrp(pro.deposited)} / ${nrp(pro.required)}` : '';
    return void (await say(chat,
      `${head(u)}\n💰 Balance: <b>${esc(nrp(u.data.balance))}</b>${hint}\n\nSend amount to ${st.cmd === 'addbalance' ? 'add' : 'cut'} (NRP) 💵`));
  }

  sessions.delete(key);
  const tok = newReqId();

  if (st.cmd === 'ban') {
    const cur = activeBan(u.data);
    pending.set(tok, { kind: 'ban', uid: u.uid, exp: Date.now() + TTL });
    return void (await say(chat,
      `${head(u)}\n${cur ? `⚠️ Already banned (${esc(cur.label)}) — choosing a time below replaces it.\n` : ''}\nChoose the ban length:`,
      { inline_keyboard: [
        [{ text: '1 Hour', callback_data: `bn:1h:${tok}` }, { text: '12 Hours', callback_data: `bn:12h:${tok}` }, { text: '1 Day', callback_data: `bn:1d:${tok}` }],
        [{ text: '3 Days', callback_data: `bn:3d:${tok}` }, { text: '7 Days', callback_data: `bn:7d:${tok}` }, { text: 'Permanent', style: 'danger', callback_data: `bn:pm:${tok}` }],
        [{ text: 'Cancel', style: 'danger', callback_data: `bn:N:${tok}` }],
      ] }));
  }

  if (st.cmd === 'unban') {
    const cur = activeBan(u.data);
    if (!cur) return void (await say(chat, `${head(u)}\n✅ This user is not banned.`));
    pending.set(tok, { kind: 'unban', uid: u.uid, exp: Date.now() + TTL });
    return void (await say(chat, `${head(u)}\n🚫 Banned: <b>${esc(cur.label)}</b>\n\nRemove the ban?`,
      { inline_keyboard: [[{ text: 'Unban', style: 'success', callback_data: `un:Y:${tok}` }, { text: 'Cancel', style: 'danger', callback_data: `un:N:${tok}` }]] }));
  }

  if (st.cmd === 'annulment') {
    const list = recentPurchases(u.data, 8);
    if (!list.length) return void (await say(chat, `${head(u)}\nNo purchases on this account.`));
    pending.set(tok, { kind: 'annul', uid: u.uid, list: list.map((p) => ({ index: p.index, at: p.at })), exp: Date.now() + TTL });
    const rows = list.map((p) => [{
      text: `${String(p.at || '').slice(0, 10)} · ${p.name || p.sku || '?'} ${p.duration || ''} · NRP ${p.price}`.slice(0, 60),
      callback_data: `an:${p.index}:${tok}`,
    }]);
    rows.push([{ text: 'Cancel', style: 'danger', callback_data: `an:N:${tok}` }]);
    return void (await say(chat, `${head(u)}\n💰 Balance: <b>${esc(nrp(u.data.balance))}</b>\n\nWhich purchase should be annulled (refunded)?`, { inline_keyboard: rows }));
  }

  // mode
  pending.set(tok, { kind: 'mode', uid: u.uid, by: key, exp: Date.now() + TTL });
  const cur = u.data.role || 'user';
  return void (await say(chat,
    `${head(u)}\nCurrent mode: <b>${esc(ROLE_LABEL[cur] || cur)}</b>\n\nChoose the new mode:`,
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
  const cut = st.cmd === 'cutbalance';
  pending.set(tok, { kind: cut ? 'cut' : 'add', uid: st.uid, amount, by: key, exp: Date.now() + TTL });
  const pre = cut ? 'cb' : 'ab';
  await say(chat, `${cut ? 'Cut' : 'Add'} <b>${esc(nrp(amount))}</b> ${cut ? 'from' : 'to'} <code>${esc(st.uid)}</code>?`, {
    inline_keyboard: [[{ text: 'Confirm', style: 'success', callback_data: `${pre}:Y:${tok}` }, { text: 'Cancel', style: 'danger', callback_data: `${pre}:N:${tok}` }]],
  });
}

// ---- button presses ----------------------------------------------------------
const KIND_OF = { ab: 'add', cb: 'cut', md: 'mode', bn: 'ban', un: 'unban', an: 'annul' };
export const BOT_CALLBACK_RE = /^(ab|cb|md|bn|un|an):([A-Za-z0-9]{1,4}):([a-f0-9]{12})$/;

export async function handleBotCallback(cb) {
  sweep();
  const m = String(cb.data).match(BOT_CALLBACK_RE);
  if (!m) return answerCallback(cb.id, 'Unknown action');
  const [, prefix, arg, tok] = m;
  const p = pending.get(tok);
  const chat = cb.message?.chat?.id, mid = cb.message?.message_id;
  if (!p) {
    await answerCallback(cb.id, 'Expired — send the command again', true);
    return editMessage(chat, mid, `${esc(cb.message?.text || '')}\n\n⌛ Expired`);
  }
  const wantKind = KIND_OF[prefix];
  if (p.kind !== wantKind && !(wantKind === 'annul' && p.kind === 'annul2')) return answerCallback(cb.id, 'Unknown action');
  pending.delete(tok);
  const by = `telegram:${cb.from?.id}`;
  const base = esc(cb.message?.text || '');

  try {
    if (arg === 'N') {
      await answerCallback(cb.id, 'Cancelled');
      return editMessage(chat, mid, `${base}\n\n❌ <b>Cancelled</b> by ${esc(who(cb.from))}`);
    }

    if (prefix === 'ab') {
      const r = await creditUser(p.uid, p.amount, { note: `Telegram /addbalance by ${who(cb.from)}`, actor: 'TELEGRAM', by });
      await answerCallback(cb.id, `Loaded ${nrp(p.amount)}`);
      await editMessage(chat, mid, `${base}\n\n✅ <b>LOADED</b> by ${esc(who(cb.from))}\n${esc(nrp(r.before))} ➝ <b>${esc(nrp(r.after))}</b>` +
        (r.proActivated ? '\n💎 <b>PRO RESELLER ACTIVATED</b> (new top-up reached the requirement)' : ''));
      if (r.proActivated) announceProActivated({ uid: p.uid, email: r.email, name: r.name, deposited: r.deposited });
      return;
    }

    if (prefix === 'cb') {
      const r = await debitUser(p.uid, p.amount, { note: `Telegram /cutbalance by ${who(cb.from)}`, actor: 'TELEGRAM', by });
      await answerCallback(cb.id, `Cut ${nrp(p.amount)}`);
      return editMessage(chat, mid, `${base}\n\n➖ <b>CUT</b> by ${esc(who(cb.from))}\n${esc(nrp(r.before))} ➝ <b>${esc(nrp(r.after))}</b>`);
    }

    if (prefix === 'bn') {
      const duration = arg === 'pm' ? 'permanent' : arg;
      if (!BAN_DURATIONS[duration]) return answerCallback(cb.id, 'Unknown ban length', true);
      const r = await banUser(p.uid, duration, by);
      telegramNotify(`🚫 <b>User banned</b> — ${esc(r.ban.label)}\nUID: <code>${esc(p.uid)}</code>\n${esc(r.email)}\nBy ${esc(who(cb.from))} (Telegram)`);
      await answerCallback(cb.id, `Banned — ${r.ban.label}`);
      return editMessage(chat, mid, `${base}\n\n🚫 <b>BANNED</b> (${esc(r.ban.label)}) by ${esc(who(cb.from))}`);
    }

    if (prefix === 'un') {
      const r = await unbanUser(p.uid, by);
      telegramNotify(`✅ <b>User unbanned</b>\nUID: <code>${esc(p.uid)}</code>\n${esc(r.email)}\nBy ${esc(who(cb.from))} (Telegram)`);
      await answerCallback(cb.id, 'Unbanned');
      return editMessage(chat, mid, `${base}\n\n✅ <b>UNBANNED</b> by ${esc(who(cb.from))}`);
    }

    if (prefix === 'an') {
      if (p.kind === 'annul') {                       // step 1: a purchase was picked
        const picked = p.list.find((x) => String(x.index) === arg);
        if (!picked) return answerCallback(cb.id, 'Unknown purchase', true);
        const tok2 = newReqId();
        pending.set(tok2, { kind: 'annul2', uid: p.uid, index: picked.index, at: picked.at, exp: Date.now() + TTL });
        await answerCallback(cb.id, 'Confirm the annulment');
        return tg('editMessageText', {
          chat_id: chat, message_id: mid, parse_mode: 'HTML', disable_web_page_preview: true,
          text: `${base}\n\n⚠️ Annul the purchase from <b>${esc(String(picked.at).slice(0, 10))}</b> and refund it to the user's balance?\nThe key itself stays with the user.`,
          reply_markup: { inline_keyboard: [[{ text: 'Annul + refund', style: 'success', callback_data: `an:Y:${tok2}` }, { text: 'Cancel', style: 'danger', callback_data: `an:N:${tok2}` }]] },
        });
      }
      const r = await annulPurchase(p.uid, p.index, p.at, { by });
      await answerCallback(cb.id, `Refunded ${nrp(r.price)}`);
      return editMessage(chat, mid, `${base}\n\n✅ <b>ANNULLED</b> by ${esc(who(cb.from))}\n${esc(r.entry.name || r.entry.sku || 'purchase')} ${esc(r.entry.duration || '')}\nRefunded ${esc(nrp(r.price))}: ${esc(nrp(r.before))} ➝ <b>${esc(nrp(r.after))}</b>`);
    }

    // md:<u|r|p>
    const role = normalizeRole(arg);
    if (!role) return answerCallback(cb.id, 'Unknown mode', true);
    const r = await setUserRole(p.uid, role, by);
    await answerCallback(cb.id, `Mode → ${ROLE_LABEL[role]}`);
    return editMessage(chat, mid, `${base}\n\n✅ <b>MODE CHANGED</b> by ${esc(who(cb.from))}\n${esc(ROLE_LABEL[r.from] || r.from)} ➝ <b>${esc(ROLE_LABEL[role])}</b>`);
  } catch (e) {
    await answerCallback(cb.id, `Failed: ${String(e.message).slice(0, 150)}`, true);
    return editMessage(chat, mid, `${base}\n\n⚠️ <b>Failed:</b> ${esc(e.message)}`);
  }
}
