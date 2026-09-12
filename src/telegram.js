// Telegram notification router.
// Configure four bot tokens on Render:
// TELEGRAM_RESELLER_BOT_TOKEN
// TELEGRAM_USER_BOT_TOKEN
// TELEGRAM_BALANCE_BOT_TOKEN
// TELEGRAM_BUG_BOT_TOKEN
// And two destination chat IDs:
// TELEGRAM_CHAT_ID_1
// TELEGRAM_CHAT_ID_2
//
// Every notification is sent only to the selected bot(s) and both chat IDs.
// Notifications are best-effort and never block the actual API operation.

const BOT_ENV = {
  reseller: 'TELEGRAM_RESELLER_BOT_TOKEN',
  user: 'TELEGRAM_USER_BOT_TOKEN',
  balance: 'TELEGRAM_BALANCE_BOT_TOKEN',
  bug: 'TELEGRAM_BUG_BOT_TOKEN',
  security: 'TELEGRAM_USER_BOT_TOKEN',
  legacy: 'TELEGRAM_BOT_TOKEN',
};

function botToken(purpose='user') {
  return process.env[BOT_ENV[purpose] || BOT_ENV.user] || process.env.TELEGRAM_BOT_TOKEN || '';
}
function chatIds() {
  return [process.env.TELEGRAM_CHAT_ID_1, process.env.TELEGRAM_CHAT_ID_2, process.env.TELEGRAM_CHAT_ID].filter(Boolean);
}

export async function telegramNotify(text, purpose='user') {
  const token = botToken(purpose);
  const ids = chatIds();
  if (!token || !ids.length) return;
  await Promise.all(ids.map(async (chatId) => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({chat_id:chatId,text,parse_mode:'HTML',disable_web_page_preview:true}),
        signal:controller.signal,
      });
      clearTimeout(timeout);
    } catch (_) {}
  }));
}

export function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
const STATUS_EMOJI={success:'✅',failed:'❌',cancelled:'🚫',pending:'⏳',attempt:'🛒'};
export function telegramFormat(title,f={}) {
  const status=String(f.status||'').toLowerCase();
  const emoji=STATUS_EMOJI[status]||'ℹ️';
  const lines=[`${emoji} <b>${esc(title)}</b>`,`👤 ${esc(f.username||'—')}`,`✉️ ${esc(f.email||'—')}`,`📦 ${esc(f.product||'—')}`];
  if(f.duration)lines.push(`⏱ ${esc(f.duration)}`);
  lines.push(`💰 Rs ${esc(f.price??'0')}`);
  if(f.key)lines.push(`🔑 <code>${esc(f.key)}</code>`);
  lines.push(`📅 ${esc(f.date||new Date().toISOString())}`,`🆔 <code>${esc(f.uid||'—')}</code>`);
  if(status)lines.push(`📊 Status: <b>${esc(status.charAt(0).toUpperCase()+status.slice(1))}</b>`);
  if(f.others)lines.push(`📝 ${esc(f.others)}`);
  return lines.join('\n');
}
