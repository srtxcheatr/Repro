// POST /api/telegram/topup-webhook — receives the [Load ✅] / [Cancel ❌] button presses
// from the top-up bot (TELEGRAM_TOPUP_AUTO_BOT). Not a user route: it is authenticated by
// Telegram's secret header AND by checking the press came from the configured chat/admins.
import express from 'express';
import { asyncHandler } from '../src/asyncHandler.js';
import { esc } from '../src/telegram.js';
import {
  webhookSecret, safeEqual, isAllowedPress, resolveRequest, answerCallback, editMessage,
  buildRequestText, strikeStep,
} from '../src/topupQr.js';

const router = express.Router();

router.post('/topup-webhook', asyncHandler(async (req, res) => {
  const given = req.headers['x-telegram-bot-api-secret-token'];
  if (!given || !safeEqual(given, webhookSecret())) return res.sendStatus(401);
  res.sendStatus(200); // answer Telegram immediately; the work below is idempotent

  const cb = req.body?.callback_query;
  if (!cb || typeof cb.data !== 'string') return;
  const m = cb.data.match(/^tq:([LC]):([a-f0-9]{12})$/);
  if (!m) return answerCallback(cb.id, 'Unknown action');
  if (!isAllowedPress(cb)) return answerCallback(cb.id, 'Not allowed', true);

  const decision = m[1] === 'L' ? 'load' : 'cancel';
  const who = cb.from?.username ? `@${cb.from.username}` : String(cb.from?.first_name || cb.from?.id || 'admin');
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

  const base = r.base || {};
  let footer;
  if (decision === 'load') {
    footer = `✅ <b>LOADED</b> by ${esc(who)}\nNRP ${r.before} ➝ <b>NRP ${r.after}</b>`;
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
}));

export default router;
