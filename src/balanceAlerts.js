// src by SRT X CHEATS. Copy right SRT X CHEATS
import { telegramNotify, esc } from './telegram.js';

const nrp = (n) => `NRP ${Number(n || 0).toLocaleString('en-US')}`;

// src by SRT X CHEATS. Copy right SRT X CHEATS
function nepalTime(d = new Date()) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kathmandu', day: '2-digit', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(d);
// src by SRT X CHEATS. Copy right SRT X CHEATS
}

export function buildBalanceAlert({
  actor,
  kind = 'load',
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  title,
  uid, email, amount, before, after, note, extraLines = [],
}) {
  const isLoad = kind !== 'deduct';
  const heading = title || (isLoad ? 'BALANCE LOAD' : 'BALANCE DEDUCTION');
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const icon = isLoad ? '💰' : '➖';
  const sign = isLoad ? '+' : '−';

  const lines = [
    `${icon} <b>${esc(actor)} ${esc(heading)}</b>`,
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    `👤 ${esc(email || '—')}`,
    `🆔 <code>${esc(uid || '—')}</code>`,
    `💵 Amount: <b>${sign}${nrp(amount)}</b>`,
  ];
  if (before !== undefined && after !== undefined) {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    lines.push(`📊 Balance: ${nrp(before)} → <b>${nrp(after)}</b>`);
  }
  for (const l of extraLines) lines.push(l);
  lines.push(`📝 Note: ${esc(note || '—')}`);
  lines.push(`🕒 ${esc(nepalTime())} (Nepal)`);
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  return lines.join('\n');
}

export function notifyBalanceChange(args) {
  try {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    return telegramNotify(buildBalanceAlert(args), 'load').catch(() => {});
  } catch (e) {
    console.warn('[balanceAlerts] could not build alert:', e?.name || 'error');
    return Promise.resolve();
  }
// src by SRT X CHEATS. Copy right SRT X CHEATS
}
