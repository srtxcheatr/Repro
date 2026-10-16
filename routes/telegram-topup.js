// POST /api/telegram/topup-webhook — everything the admin bot (TELEGRAM_TOPUP_AUTO_BOT) receives:
//   * [Load ✅] / [Cancel ❌]        QR top-up approval        (callback tq:)
//   * [Approved ✅] / [CANCEL ❌]    Pro Reseller approval     (callback pr:)
//   * /addbalance /getdetail /mode   admin commands + their buttons (message, ab:, md:)
// Not a user route: authenticated by Telegram's secret header AND by checking the
// press/message came from the configured chat / admins.
import express from 'express';
import { asyncHandler } from '../src/asyncHandler.js';
import { esc } from '../src/telegram.js';
import {
  webhookSecret, safeEqual, isAllowedPress, resolveRequest, answerCallback, editMessage,
} from '../src/topupQr.js';
import { strikeStep } from '../src/topupQr.js';
import { resolveProRequest } from '../src/proReseller.js';
import { handleMessage, handleBotCallback } from '../src/telegramBot.js';
import { PRO_MIN_TOPUP } from '../src/proTier.js';

const router = express.Router();
const whoIs = (cb) => (cb.from?.username ? `@${cb.from.username}` : String(cb.from?.first_name || cb.from?.id || 'admin'));

async function onQrCallback(cb, m) {
  const decision = m[1] === 'L' ? 'load' : 'cancel';
  const who = whoIs(cb);
  const r = await resolveRequest(m[2], decision, `telegram:${cb.from?.id}`);

  if (!r.ok) {
    await answerCallback(cb.id, `Not processed: ${r.reason}`, true);
    // Already handled elsewhere (e.g. admin panel)? Strip the buttons so nobody presses twice.
    if (r.status && cb.message) {
      const icon = r.status === 'APPROVED' ? '✅' : '❌';
      await editMessage(cb.message.chat.id, cb.message.message_id, `${cb.message.text}\n\n${icon} <b>Already ${esc(r.status)}</b>`);
    }
    return;
  }

  let footer;
  if (decision === 'load') {
    footer = `✅ <b>LOADED</b> by ${esc(who)}\nNRP ${r.before} ➝ <b>NRP ${r.after}</b>`;
    if (r.proActivated) footer += '\n💎 <b>PRO RESELLER ACTIVATED</b> (new top-up reached the requirement)';
    await answerCallback(cb.id, `Loaded NRP ${r.amount}`);
  } else {
    const step = strikeStep(r.count);
    const sentence = step.action === 'warning' ? '⚠️ warning sent to user' : step.action === '1d' ? '⛔ banned for 1 day' : '⛔ banned permanently';
    footer = `❌ <b>CANCELLED</b> by ${esc(who)}\nFake payment strike <b>${Math.min(r.count, 3)}/3</b> — ${sentence}`;
    await answerCallback(cb.id, `Cancelled — strike ${Math.min(r.count, 3)}/3`);
  }
  // Edit EVERY copy of this request (several chats may have received it).
  const original = cb.message?.text || '';
  for (const msg of (r.messages.length ? r.messages : [{ chat_id: cb.message.chat.id, message_id: cb.message.message_id }])) {
    await editMessage(msg.chat_id, msg.message_id, `${esc(original)}\n\n${footer}`);
  }
}

async function onProCallback(cb, m) {
  const approve = m[1] === 'A';
  const who = whoIs(cb);
  const r = await resolveProRequest(m[2], approve ? 'approve' : 'reject', `telegram:${cb.from?.id}`);

  if (!r.ok) {
    await answerCallback(cb.id, `Not processed: ${r.reason}`, true);
    if (r.status && cb.message) {
      const icon = r.status === 'APPROVED' ? '✅' : r.status === 'REJECTED' ? '❌' : 'ℹ️';
      await editMessage(cb.message.chat.id, cb.message.message_id, `${esc(cb.message.text)}\n\n${icon} <b>Already ${esc(r.status)}</b>`);
    }
    return;
  }
  const footer = approve
    ? `✅ <b>APPROVED</b> by ${esc(who)}\nUser must now make a NEW top-up of NRP ${PRO_MIN_TOPUP} to become PRO RESELLER.`
    : `❌ <b>CANCELLED</b> by ${esc(who)}\nThe user can apply again.`;
  await answerCallback(cb.id, approve ? 'Approved' : 'Cancelled');
  const original = cb.message?.text || '';
  for (const msg of (r.messages.length ? r.messages : [{ chat_id: cb.message.chat.id, message_id: cb.message.message_id }])) {
    await editMessage(msg.chat_id, msg.message_id, `${esc(original)}\n\n${footer}`);
  }
}

router.post('/topup-webhook', asyncHandler(async (req, res) => {
  const given = req.headers['x-telegram-bot-api-secret-token'];
  if (!given || !safeEqual(given, webhookSecret())) return res.sendStatus(401);
  res.sendStatus(200); // answer Telegram immediately; the work below is idempotent

  try {
    if (req.body?.message) return await handleMessage(req.body.message);

    const cb = req.body?.callback_query;
    if (!cb || typeof cb.data !== 'string') return;
    if (!isAllowedPress(cb)) return await answerCallback(cb.id, 'Not allowed', true);

    let m;
    if ((m = cb.data.match(/^tq:([LC]):([a-f0-9]{12})$/))) return await onQrCallback(cb, m);
    if ((m = cb.data.match(/^pr:([AC]):([a-f0-9]{12})$/))) return await onProCallback(cb, m);
    if (/^(ab|md):/.test(cb.data)) return await handleBotCallback(cb);
    return await answerCallback(cb.id, 'Unknown action');
  } catch (e) {
    console.warn('[telegram-webhook] handler error:', e?.message || e);
  }
}));

export default router;
