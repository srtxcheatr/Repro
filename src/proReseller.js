// src by SRT X CHEATS. Copy right SRT X CHEATS
import { esc } from './telegram.js';
import { tg, chatIds } from './topupQr.js';
import { PRO_MIN_DEPOSIT, PRO_MIN_KEYS } from './proTier.js';

// Pro Reseller now unlocks automatically (10+ keys + ONE deposit of NRP 3500+), so there is no
// request / approval flow any more — only the announcement below.
export async function announce(text) {
  await Promise.all(chatIds().map((chat_id) => tg('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true })));
}

export const announceProActivated = ({ uid, email, name, deposited }) => announce(
  `💎 <b>PRO RESELLER ACTIVATED</b>\n👤 ${esc(name || '—')}\n✉️ ${esc(email || '—')}\n🆔 <code>${esc(uid)}</code>\n` +
  `Single deposit: NRP ${esc(deposited)} (needed ${PRO_MIN_DEPOSIT}) · ${PRO_MIN_KEYS}+ keys bought\nPro prices are now live for this account.`
);
