// src by SRT X CHEATS. Copy right SRT X CHEATS
import express from 'express';
import { asyncHandler } from '../src/asyncHandler.js';
import { esc } from '../src/telegram.js';
import {
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  webhookSecret, safeEqual, isAllowedPress, resolveRequest, answerCallback, editMessage, botToken,
} from '../src/topupQr.js';
import { handleSupportMessage, handleSupportCallback, SUPPORT_CALLBACK_RE } from '../src/supportBot.js';
import { redact } from '../src/security.js';
import { strikeStep } from '../src/topupQr.js';
import { resolveProRequest } from '../src/proReseller.js';
import { handleMessage, handleBotCallback, BOT_CALLBACK_RE } from '../src/telegramBot.js';
// src by SRT X CHEATS. Copy right SRT X CHEATS
import { PRO_MIN_TOPUP } from '../src/proTier.js';
import { notifyDepositUser } from '../src/depositBot.js';

const router = express.Router();
const whoIs = (cb) => (cb.from?.username ? `@${cb.from.username}` : String(cb.from?.first_name || cb.from?.id || 'admin'));

// src by SRT X CHEATS. Copy right SRT X CHEATS
async function onQrCallback(cb, m) {
  const decision = m[1] === 'L' ? 'load' : 'cancel';
  const who = whoIs(cb);
  const r = await resolveRequest(m[2], decision, `telegram:${cb.from?.id}`);

  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (!r.ok) {
    await answerCallback(cb.id, `Not processed: ${r.reason}`, true);
    if (r.status && cb.message) {
      const icon = r.status === 'APPROVED' ? '✅' : '❌';
      await editMessage(cb.message.chat.id, cb.message.message_id, `${cb.message.text}\n\n${icon} <b>Already ${esc(r.status)}</b>`);
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    }
    return;
  }

  let footer;
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (decision === 'load') {
    footer = `✅ <b>LOADED</b> by ${esc(who)}\nNRP ${r.before} ➝ <b>NRP ${r.after}</b>`;
    if (r.proActivated) footer += '\n💎 <b>PRO RESELLER ACTIVATED</b> (new top-up reached the requirement)';
    await answerCallback(cb.id, `Loaded NRP ${r.amount}`);
  } else {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    const step = strikeStep(r.count);
    const sentence = step.action === 'warning' ? '⚠️ warning sent to user' : step.action === '1d' ? '⛔ banned for 1 day' : '⛔ banned permanently';
    footer = `❌ <b>CANCELLED</b> by ${esc(who)}\nFake payment strike <b>${Math.min(r.count, 3)}/3</b> — ${sentence}`;
    await answerCallback(cb.id, `Cancelled — strike ${Math.min(r.count, 3)}/3`);
  }
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const original = cb.message?.text || '';
  for (const msg of (r.messages.length ? r.messages : [{ chat_id: cb.message.chat.id, message_id: cb.message.message_id }])) {
    await editMessage(msg.chat_id, msg.message_id, `${esc(original)}\n\n${footer}`);
  }
  // deposits started from the Telegram deposit bot: tell the user the result in that chat
  const tgChat = r.base?.tgChatId;
  if (tgChat) {
    await notifyDepositUser(tgChat, decision === 'load'
      ? `✅ <b>Balance loaded</b>\nNRP ${r.amount} was added.\nNew balance: <b>NRP ${r.after}</b>`
      : '❌ <b>Deposit cancelled</b>\nWe could not verify your payment. Please contact support if you already paid.');
  }
}
// src by SRT X CHEATS. Copy right SRT X CHEATS

async function onProCallback(cb, m) {
  const approve = m[1] === 'A';
  const who = whoIs(cb);
  const r = await resolveProRequest(m[2], approve ? 'approve' : 'reject', `telegram:${cb.from?.id}`);
// src by SRT X CHEATS. Copy right SRT X CHEATS

  if (!r.ok) {
    await answerCallback(cb.id, `Not processed: ${r.reason}`, true);
    if (r.status && cb.message) {
      const icon = r.status === 'APPROVED' ? '✅' : r.status === 'REJECTED' ? '❌' : 'ℹ️';
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      await editMessage(cb.message.chat.id, cb.message.message_id, `${esc(cb.message.text)}\n\n${icon} <b>Already ${esc(r.status)}</b>`);
    }
    return;
  }
  const footer = approve
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    ? `✅ <b>APPROVED</b> by ${esc(who)}\nUser must now make a NEW top-up of NRP ${PRO_MIN_TOPUP} to become PRO RESELLER.`
    : `❌ <b>CANCELLED</b> by ${esc(who)}\nThe user can apply again.`;
  await answerCallback(cb.id, approve ? 'Approved' : 'Cancelled');
  const original = cb.message?.text || '';
  for (const msg of (r.messages.length ? r.messages : [{ chat_id: cb.message.chat.id, message_id: cb.message.message_id }])) {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    await editMessage(msg.chat_id, msg.message_id, `${esc(original)}\n\n${footer}`);
  }
}

router.post('/topup-webhook', asyncHandler(async (req, res) => {
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const given = req.headers['x-telegram-bot-api-secret-token'];
  // no bot configured => the derived secret would be predictable, so refuse everything
  if (!botToken() || !given || !safeEqual(given, webhookSecret())) return res.sendStatus(401);
  res.sendStatus(200);

  try {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    if (req.body?.message) {
      // replies to a support prompt (text / photo) are consumed here; everything else is a normal admin command
      if (await handleSupportMessage(req.body.message)) return;
      return await handleMessage(req.body.message);
    }

    const cb = req.body?.callback_query;
    if (!cb || typeof cb.data !== 'string') return;
    if (!isAllowedPress(cb)) return await answerCallback(cb.id, 'Not allowed', true);
// src by SRT X CHEATS. Copy right SRT X CHEATS

    let m;
    if ((m = cb.data.match(/^tq:([LC]):([a-f0-9]{12})$/))) return await onQrCallback(cb, m);
    if ((m = cb.data.match(/^pr:([AC]):([a-f0-9]{12})$/))) return await onProCallback(cb, m);
    if ((m = cb.data.match(SUPPORT_CALLBACK_RE))) return await handleSupportCallback(cb, m);
    if (BOT_CALLBACK_RE.test(cb.data)) return await handleBotCallback(cb);
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    return await answerCallback(cb.id, 'Unknown action');
  } catch (e) {
    console.warn('[telegram-webhook] handler error:', redact(e?.message || e).slice(0, 300));
  }
}));
// src by SRT X CHEATS. Copy right SRT X CHEATS

export default router;
