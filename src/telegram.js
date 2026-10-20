// src by SRT X CHEATS. Copy right SRT X CHEATS
// Bots (one env var per job). Each falls back to the older bot so nothing breaks if a new one is not set yet.
//   user      -> TELEGRAM_USER_BOT_TOKEN      (general alerts)
//   purchase  -> TELEGRAM_PURCHASE_BOT_TOKEN  (every key purchase: attempt / success / rejected)
//   health    -> TELEGRAM_HEALTH_BOT_TOKEN    (website + backend health, server errors)
//   bug       -> TELEGRAM_BUG_BOT_TOKEN       (bug reports from users)
//   balance / load / reseller / report  (see below)
// Chat ids: TELEGRAM_<NAME>_CHAT_ID (comma separated), else TELEGRAM_CHAT_ID_1 / _2 / TELEGRAM_CHAT_ID.
const TOKEN_ENV = {
  reseller: ['TELEGRAM_RESELLER_BOT_TOKEN'],
  user: ['TELEGRAM_USER_BOT_TOKEN'],
  balance: ['TELEGRAM_BALANCE_BOT_TOKEN'],
  bug: ['TELEGRAM_BUG_BOT_TOKEN'],
  security: ['TELEGRAM_USER_BOT_TOKEN'],
  purchase: ['TELEGRAM_PURCHASE_BOT_TOKEN', 'TELEGRAM_USER_BOT_TOKEN'],
  health: ['TELEGRAM_HEALTH_BOT_TOKEN', 'TELEGRAM_USER_BOT_TOKEN'],
  report: ['TELEGRAM_REPORT_BOT_TOKEN', 'TELEGRAM_USER_BOT_TOKEN'],
  load: ['TELEGRAM_LOAD_BOT_TOKEN', 'TELEGRAM_BALANCE_BOT_TOKEN'],
  legacy: ['TELEGRAM_BOT_TOKEN'],
};
const OWN_CHAT_ENV = {
  purchase: 'TELEGRAM_PURCHASE_CHAT_ID',
  health: 'TELEGRAM_HEALTH_CHAT_ID',
  report: 'TELEGRAM_REPORT_CHAT_ID',
  load: 'TELEGRAM_LOAD_CHAT_ID',
};
export const NOTIFY_PURPOSES = ['user', 'purchase', 'health', 'bug', 'balance', 'load', 'reseller', 'report'];

const csv = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);

function botToken(purpose = 'user') {
  for (const k of (TOKEN_ENV[purpose] || TOKEN_ENV.user)) if (process.env[k]) return process.env[k];
  return process.env.TELEGRAM_BOT_TOKEN || '';
}
function defaultChatIds() {
  return [process.env.TELEGRAM_CHAT_ID_1, process.env.TELEGRAM_CHAT_ID_2, process.env.TELEGRAM_CHAT_ID].filter(Boolean);
}
function chatIds(purpose = 'user') {
  const own = OWN_CHAT_ENV[purpose] ? csv(process.env[OWN_CHAT_ENV[purpose]]) : [];
  return own.length ? own : defaultChatIds();
}

const warnedMixed = new Set();
function warnIfMixedConfig(purpose) {
  const tokEnv = TOKEN_ENV[purpose]?.[0];
  const chatEnv = OWN_CHAT_ENV[purpose];
  if (!tokEnv || !chatEnv || warnedMixed.has(purpose)) return;
  if (!!process.env[tokEnv] !== !!process.env[chatEnv]) {
    warnedMixed.add(purpose);
    console.warn(`[telegram:${purpose}] Only one of ${tokEnv} / ${chatEnv} is set. Set BOTH, or alerts fall back to the old bot/chat.`);
  }
}

// ---- delivery -------------------------------------------------------------
// Fire-and-forget callers never see an error, so a failed send used to vanish silently
// (Telegram 429 flood limit, a 5 s timeout on a cold Render instance, a group that was upgraded to a
// supergroup, ...). sendOne() retries those cases and records the reason so /notifytest can show it.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
function recordFailure(purpose, chatId, reason) {
  failures.unshift({ at: new Date().toISOString(), purpose, chatId: String(chatId), reason });
  if (failures.length > 20) failures.length = 20;
  console.warn(`[telegram:${purpose}] NOT delivered to ${chatId}: ${reason}`);
}
export const notifyFailures = () => failures.slice();

const stripTags = (t) => String(t).replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

async function sendOne(token, chatId, text, purpose, { record = true } = {}) {
  let id = chatId;
  let plain = false;
  let reason = 'unknown error';
  for (let attempt = 1; attempt <= 4; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: id, text: plain ? stripTags(text) : String(text).slice(0, 4000),
          ...(plain ? {} : { parse_mode: 'HTML' }), disable_web_page_preview: true,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (r.ok) return null;
      let j = {};
      try { j = await r.json(); } catch (_) {}
      reason = `HTTP ${r.status} ${j.description || ''}`.trim();
      const migrated = j?.parameters?.migrate_to_chat_id;
      if (migrated && String(migrated) !== String(id)) {
        console.warn(`[telegram:${purpose}] chat ${id} was upgraded to a supergroup - set the chat id to ${migrated}`);
        id = migrated; continue;
      }
      if (r.status === 400 && /parse entities/i.test(j.description || '') && !plain) { plain = true; continue; }
      if (r.status === 429) { await sleep(Math.min(Number(j?.parameters?.retry_after) || 2, 10) * 1000); continue; }
      if (r.status >= 500) { await sleep(attempt * 1000); continue; }
      break;
    } catch (e) {
      clearTimeout(timer);
      reason = e?.name === 'AbortError' ? 'timeout' : `network error (${e?.message || e?.name || 'unknown'})`;
      await sleep(attempt * 1000);
    }
  }
  if (record) recordFailure(purpose, chatId, reason);
  return reason;
}

// Returns the list of failures (empty = delivered everywhere). Never throws.
export async function telegramNotify(text, purpose = 'user') {
  warnIfMixedConfig(purpose);
  const token = botToken(purpose);
  const ids = chatIds(purpose);
  if (!token || !ids.length) {
    console.warn(`[telegram:${purpose}] No bot token / chat id configured - message not sent.`);
    return ['not configured'];
  }
  const out = [];
  await Promise.all(ids.map(async (chatId) => {
    let why = await sendOne(token, chatId, text, purpose, { record: purpose === 'user' });
    if (why && purpose !== 'user') {
      // dedicated bot failed - fall back to the general bot so the message is not lost
      const fbToken = botToken('user'); const fbIds = defaultChatIds();
      if (fbToken && fbIds.length && (fbToken !== token || fbIds.map(String).join() !== ids.map(String).join())) {
        const fb = await Promise.all(fbIds.map((c) => sendOne(fbToken, c, `(${purpose} bot failed: ${why})\n${text}`, 'user')));
        if (fb.some((x) => !x)) { recordFailure(purpose, chatId, `${why} (delivered through the general bot instead)`); return; }
      }
      recordFailure(purpose, chatId, why);
    }
    if (why) out.push(why);
  }));
  return out;
}

// Identifies where a purpose really delivers (used to avoid testing the same bot+chat twice).
export function describeTarget(purpose) {
  const token = botToken(purpose);
  return token ? `${token.slice(0, 12)}|${chatIds(purpose).join(',')}` : '';
}

// For /notifytest: sends a test line through one purpose and reports exactly what Telegram said.
export async function testNotify(purpose) {
  const token = botToken(purpose);
  const ids = chatIds(purpose);
  if (!token) return { purpose, ok: false, detail: 'no bot token set' };
  if (!ids.length) return { purpose, ok: false, detail: 'no chat id set' };
  const res = await Promise.all(ids.map((c) => sendOne(token, c, `✅ <b>${esc(purpose)}</b> bot test - if you can read this, ${esc(purpose)} alerts reach this chat.`, purpose, { record: false })));
  const bad = res.map((r, i) => (r ? `${ids[i]}: ${r}` : null)).filter(Boolean);
  return { purpose, ok: !bad.length, detail: bad.length ? bad.join('; ') : `sent to ${ids.length} chat(s)`, tokenFrom: (TOKEN_ENV[purpose] || []).find((k) => process.env[k]) || (process.env.TELEGRAM_BOT_TOKEN ? 'TELEGRAM_BOT_TOKEN' : '-') };
}

// src by SRT X CHEATS. Copy right SRT X CHEATS
export function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

export function formatNepaliDateTime(input) {
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const d = input ? new Date(input) : new Date();
  if (isNaN(d.getTime())) return String(input ?? '—');
  const formatted = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kathmandu',
    day: '2-digit', month: 'short', year: 'numeric',
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
  }).format(d).replace(',', ',');
  return `${formatted} (Nepal Time)`;
}

// src by SRT X CHEATS. Copy right SRT X CHEATS
const STATUS_EMOJI={success:'✅',failed:'❌',cancelled:'🚫',pending:'⏳',attempt:'🛒'};
export function telegramFormat(title,f={}) {
  const status=String(f.status||'').toLowerCase();
  const emoji=STATUS_EMOJI[status]||'ℹ️';
  const lines=[`${emoji} <b>${esc(title)}</b>`,`👤 ${esc(f.username||'—')}`,`✉️ ${esc(f.email||'—')}`];
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if(f.phone)lines.push(`📱 Number - ${esc(f.phone)}`);
  lines.push(`📦 ${esc(f.product||'—')}`);
  if(f.duration)lines.push(`⏱ ${esc(f.duration)}`);
  lines.push(`💰 Rs ${esc(f.price??'0')}`);
  if(f.key)lines.push(`🔑 <code>${esc(f.key)}</code>`);
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  lines.push(`📅 ${esc(formatNepaliDateTime(f.date))}`,`🆔 <code>${esc(f.uid||'—')}</code>`);
  if(f.balanceBefore!==undefined && f.balanceAfter!==undefined){
    lines.push(`NRP :- ${esc(f.balanceBefore)} ➝ ${esc(f.balanceAfter)}`);
  }
  if(status)lines.push(`📊 Status: <b>${esc(status.charAt(0).toUpperCase()+status.slice(1))}</b>`);
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if(f.others)lines.push(`📝 ${esc(f.others)}`);
  return lines.join('\n');
}
