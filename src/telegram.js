// src by SRT X CHEATS. Copy right SRT X CHEATS
const BOT_ENV = {
  reseller: 'TELEGRAM_RESELLER_BOT_TOKEN',
  user: 'TELEGRAM_USER_BOT_TOKEN',
  balance: 'TELEGRAM_BALANCE_BOT_TOKEN',
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  bug: 'TELEGRAM_BUG_BOT_TOKEN',
  security: 'TELEGRAM_USER_BOT_TOKEN',
  legacy: 'TELEGRAM_BOT_TOKEN',
};

// src by SRT X CHEATS. Copy right SRT X CHEATS
function botToken(purpose='user') {
  if (purpose === 'load') {
    return process.env.TELEGRAM_LOAD_BOT_TOKEN || process.env.TELEGRAM_BALANCE_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
  }
  return process.env[BOT_ENV[purpose] || BOT_ENV.user] || process.env.TELEGRAM_BOT_TOKEN || '';
// src by SRT X CHEATS. Copy right SRT X CHEATS
}
function chatIds(purpose='user') {
  if (purpose === 'load') {
    const own = String(process.env.TELEGRAM_LOAD_CHAT_ID || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (own.length) return own;
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  }
  return [process.env.TELEGRAM_CHAT_ID_1, process.env.TELEGRAM_CHAT_ID_2, process.env.TELEGRAM_CHAT_ID].filter(Boolean);
}

let warnedMixedLoadConfig = false;
// src by SRT X CHEATS. Copy right SRT X CHEATS
function warnIfMixedLoadConfig() {
  if (warnedMixedLoadConfig) return;
  const hasTok = !!process.env.TELEGRAM_LOAD_BOT_TOKEN;
  const hasChat = !!process.env.TELEGRAM_LOAD_CHAT_ID;
  if (hasTok !== hasChat) {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    warnedMixedLoadConfig = true;
    console.warn('[telegram:load] Only one of TELEGRAM_LOAD_BOT_TOKEN / TELEGRAM_LOAD_CHAT_ID is set. Set BOTH, or alerts will go to the old bot/chat.');
  }
}

// src by SRT X CHEATS. Copy right SRT X CHEATS
export async function telegramNotify(text, purpose='user') {
  if (purpose === 'load') warnIfMixedLoadConfig();
  const token = botToken(purpose);
  const ids = chatIds(purpose);
  if (!token || !ids.length) {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    if (purpose === 'load') console.warn('[telegram:load] No bot token / chat id configured — balance alert not sent.');
    return;
  }
  await Promise.all(ids.map(async (chatId) => {
    try {
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        // src by SRT X CHEATS. Copy right SRT X CHEATS
        body:JSON.stringify({chat_id:chatId,text,parse_mode:'HTML',disable_web_page_preview:true}),
        signal:controller.signal,
      });
      clearTimeout(timeout);
      if (!r.ok) {
        // src by SRT X CHEATS. Copy right SRT X CHEATS
        let why = '';
        try { why = (await r.json()).description || ''; } catch (_) {}
        console.warn(`[telegram:${purpose}] send failed (HTTP ${r.status}) ${why}`.trim());
      }
    } catch (e) {
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      console.warn(`[telegram:${purpose}] send error: ${e?.name || 'unknown'}`);
    }
  }));
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
