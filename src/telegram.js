// src/telegram.js — admin notifications via a Telegram bot.
//
// SETUP:
// 1. Message @BotFather on Telegram → /newbot → follow the prompts.
//    You get a token that looks like 123456:ABC-DEF...
// 2. Add the bot to the group/channel you want alerts in (or just
//    message it directly for a personal chat).
// 3. Get the chat id: message the bot, then open
//    https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates in a browser
//    and read "chat":{"id": ...} from the response.
// 4. On Render: add environment variables TELEGRAM_BOT_TOKEN and
//    TELEGRAM_CHAT_ID with those two values.
//
// If those env vars aren't set, or the Telegram API call fails for
// any reason, this silently does nothing — a notification failing
// must never block or fail the actual purchase/top-up it's reporting
// on.

export async function telegramNotify(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // never hang a real request
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
  } catch (e) {
    // Swallow — notifications are best-effort only.
  }
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STATUS_EMOJI = {
  success: '✅', failed: '❌', cancelled: '🚫', pending: '⏳', attempt: '🛒',
};

/**
 * Builds one consistently-formatted message from the fields you asked
 * for: username, email, product, price, date, uid, status, others.
 */
export function telegramFormat(title, f = {}) {
  const status = String(f.status || '').toLowerCase();
  const emoji = STATUS_EMOJI[status] || 'ℹ️';

  const lines = [
    `${emoji} <b>${esc(title)}</b>`,
    `👤 ${esc(f.username || '—')}`,
    `✉️ ${esc(f.email || '—')}`,
    `📦 ${esc(f.product || '—')}`,
  ];
  if (f.duration) lines.push(`⏱ ${esc(f.duration)}`);
  lines.push(`💰 Rs ${esc(f.price ?? '0')}`);
  if (f.key) lines.push(`🔑 <code>${esc(f.key)}</code>`);
  lines.push(
    `📅 ${esc(f.date || new Date().toISOString())}`,
    `🆔 <code>${esc(f.uid || '—')}</code>`,
  );
  if (status !== '') {
    lines.push(`📊 Status: <b>${esc(status.charAt(0).toUpperCase() + status.slice(1))}</b>`);
  }
  if (f.others) {
    lines.push(`📝 ${esc(f.others)}`);
  }
  return lines.join('\n');
}
