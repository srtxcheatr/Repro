// src by SRT X CHEATS. Copy right SRT X CHEATS
// Support tickets on the PRIVATE admin bot (TELEGRAM_TOPUP_AUTO_BOT, same webhook + same admin chats).
//
//   new ticket  ->  formatted message with [Send Message] [Send Photo]
//   [Send Message]  -> bot asks (force-reply) for the text -> admin replies to THAT prompt -> text is added to the ticket
//   [Send Photo]    -> bot asks for the photo -> uploaded to ImgBB (key stays on the server) -> bot asks for the text
//                      (send "-" for no text) -> photo + text are added to the ticket
//
// Concurrency: every prompt message gets its own Firestore session keyed by chat+prompt message id, and the admin
// has to *reply* to that prompt. Two tickets / two admins in flight therefore can never be mixed up.
import { tg, botToken, chatIds, adminIds, answerCallback } from './topupQr.js';
import { esc, formatNepaliDateTime } from './telegram.js';
import { uploadImage } from './imgbb.js';
import { redact } from './security.js';
import { store, SupportError, TICKET_RE, REPLY_MAX } from './support.js';

export const SUPPORT_CALLBACK_RE = /^sp:([MP]):(SRT_X_[A-Z0-9]{10})$/;
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const who = (from) => (from?.username ? `@${from.username}` : String(from?.first_name || from?.id || 'admin'));

function allowed(chatId, fromId) {
  if (!chatId || !chatIds().map(String).includes(String(chatId))) return false;
  const a = adminIds();
  return a.length === 0 || a.includes(String(fromId));
}

export function buildTicketText(t, footer = '') {
  const line = '━━━━━━━━━━━━━━━━━━';
  return [
    '🎫 <b>SUPPORT TICKET</b>',
    line,
    `🆔 <b>Ticket</b> - <code>${esc(t.ticketId)}</code>`,
    `📌 <b>Type</b> - ${esc(t.type)}`,
    `👤 <b>Name</b> - ${esc(t.name || '—')}`,
    `📱 <b>Phone</b> - ${esc(t.phone || '—')}`,
    `✉️ <b>Email</b> - ${esc(t.email || '—')}`,
    `🔑 <b>UID</b> - <code>${esc(t.uid)}</code>`,
    `🌐 <b>IP</b> - <code>${esc(t.ip || '—')}</code>`,
    `📅 <b>Date</b> - ${esc(formatNepaliDateTime(t.createdAt))}`,
    line,
    `📝 ${esc(t.description)}`,
    line,
    footer,
  ].filter(Boolean).join('\n');
}
const keyboard = (id) => ({ inline_keyboard: [[
  { text: 'Send Message', callback_data: `sp:M:${id}` },
  { text: 'Send Photo', callback_data: `sp:P:${id}` },
]] });

// Called by the website API after the ticket is saved. Never throws: the ticket exists even if Telegram is down.
export async function announceTicket(ticket) {
  const ids = chatIds();
  if (!botToken() || !ids.length) { console.warn('[support] admin bot / chat id not configured - ticket saved but not announced.'); return; }
  const sent = [];
  await Promise.all(ids.map(async (chat_id) => {
    const r = await tg('sendMessage', { chat_id, text: buildTicketText(ticket), parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: keyboard(ticket.ticketId) });
    if (r?.ok) sent.push({ chat_id: r.result.chat.id, message_id: r.result.message_id });
  }));
  if (sent.length) await store.setTg(ticket.ticketId, sent).catch(() => {});
}

// The user cancelled: remove the buttons so nobody replies to a dead ticket.
export async function announceCancelled(ticket) {
  for (const m of ticket.tg || []) {
    await tg('editMessageText', {
      chat_id: m.chat_id, message_id: m.message_id, parse_mode: 'HTML', disable_web_page_preview: true,
      text: buildTicketText(ticket, '🚫 <b>CANCELLED</b> by the user'), reply_markup: { inline_keyboard: [] },
    });
  }
}
async function markReplied(ticket, by) {
  for (const m of ticket.tg || []) {
    await tg('editMessageText', {
      chat_id: m.chat_id, message_id: m.message_id, parse_mode: 'HTML', disable_web_page_preview: true,
      text: buildTicketText(ticket, `✅ <b>SOLVED</b> · last reply by ${esc(by)} (${ticket.replies.length})`), reply_markup: keyboard(ticket.ticketId),
    });
  }
}

const prompt = (chat_id, text, placeholder) => tg('sendMessage', {
  chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true,
  reply_markup: { force_reply: true, selective: true, input_field_placeholder: placeholder },
});

// ---- button press -----------------------------------------------------------------------------
export async function handleSupportCallback(cb, m) {
  const [, action, ticketId] = m;
  const chat = cb.message?.chat?.id;
  if (!allowed(chat, cb.from?.id)) return answerCallback(cb.id, 'Not allowed', true);
  const t = await store.getTicket(ticketId);
  if (!t) return answerCallback(cb.id, 'Ticket not found', true);
  if (t.status === 'cancelled') return answerCallback(cb.id, 'The user cancelled this ticket', true);

  const isPhoto = action === 'P';
  const r = await prompt(chat,
    `${isPhoto ? '🖼 Reply to <b>this message</b> with the <b>photo</b>' : '✉️ Reply to <b>this message</b> with the <b>text</b>'} for ticket <code>${esc(ticketId)}</code>\n` +
    `👤 ${esc(t.name || '—')}`,
    isPhoto ? 'Attach a photo…' : 'Type your message…');
  if (!r?.ok) return answerCallback(cb.id, 'Could not open the reply prompt', true);
  await store.createSession(chat, r.result.message_id, { ticketId, step: isPhoto ? 'photo' : 'text', adminId: String(cb.from.id), photoUrl: '' });
  return answerCallback(cb.id, isPhoto ? 'Reply with the photo' : 'Reply with the text');
}

// ---- admin reply -----------------------------------------------------------------------------
async function downloadTelegramImage(msg) {
  let fileId, size = 0, mime = '';
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const ok = msg.photo.filter((p) => !p.file_size || p.file_size <= MAX_PHOTO_BYTES);
    const pick = ok.length ? ok[ok.length - 1] : null;                       // largest one that fits
    if (!pick) throw new SupportError(413, 'Photo is too large (max 4 MB).');
    fileId = pick.file_id; size = pick.file_size || 0;
  } else if (msg.document && IMAGE_MIME.has(String(msg.document.mime_type || '').toLowerCase())) {
    fileId = msg.document.file_id; size = msg.document.file_size || 0; mime = msg.document.mime_type;
    if (size > MAX_PHOTO_BYTES) throw new SupportError(413, 'Photo is too large (max 4 MB).');
  } else {
    throw new SupportError(400, 'Please send a photo (JPG, PNG or WebP).');
  }
  const f = await tg('getFile', { file_id: fileId });
  const path = f?.result?.file_path;
  if (!path || !/^[\w./-]+$/.test(path)) throw new SupportError(502, 'Telegram did not return the file.');
  let res;
  try {
    res = await fetch(`https://api.telegram.org/file/bot${botToken()}/${path}`, { signal: AbortSignal.timeout(15_000) });
  } catch (e) { throw new SupportError(504, 'Could not download the photo from Telegram.'); }
  if (!res.ok) throw new SupportError(502, 'Could not download the photo from Telegram.');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_PHOTO_BYTES) throw new SupportError(413, 'Photo is too large (max 4 MB).');
  return buf.toString('base64');
}

// Returns true when the message belonged to a support prompt (so the normal command handler must not see it).
export async function handleSupportMessage(msg) {
  const reply = msg?.reply_to_message;
  const chat = msg?.chat?.id;
  if (!reply || !chat || !allowed(chat, msg.from?.id)) return false;

  const sess = await store.readSession(chat, reply.message_id);
  if (!sess) return false;
  const say = (text) => tg('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_to_message_id: msg.message_id });
  if (String(msg.from.id) !== String(sess.adminId)) { await say('⛔ This prompt belongs to another admin. Press the button yourself to reply.'); return true; }

  const leased = await store.leaseSession(chat, reply.message_id);
  if (!leased) return true;                                    // expired, or already being processed
  const by = who(msg.from);
  const text = String(msg.text ?? msg.caption ?? '').trim();

  try {
    if (leased.step === 'text') {
      if (!msg.text) { await store.releaseSession(chat, reply.message_id); await say('Please reply with <b>text</b>.'); return true; }
      if ([...text].length > REPLY_MAX) { await store.releaseSession(chat, reply.message_id); await say(`Too long (max ${REPLY_MAX} characters). Reply again with a shorter text.`); return true; }
      const out = await store.addReply(leased.ticketId, { text }, by);
      await store.deleteSession(chat, reply.message_id);
      await say(`✅ Message delivered to ticket <code>${esc(leased.ticketId)}</code>. Ticket is now <b>Solved</b>.`);
      await markReplied(out.ticket, by);
      return true;
    }

    if (leased.step === 'photo') {
      let url;
      try {
        const b64 = await downloadTelegramImage(msg);
        url = await uploadImage(b64, `support_${leased.ticketId}`, { maxChars: 6_000_000 });
      } catch (e) {
        await store.releaseSession(chat, reply.message_id);       // admin can simply reply again
        await say(`⚠️ ${esc(e instanceof SupportError || e?.status ? e.message : 'Photo upload failed. Try again.')}`);
        if (!(e instanceof SupportError) && !e?.status) console.warn('[support] photo flow error:', redact(e).slice(0, 200));
        return true;
      }
      const r = await prompt(chat, `✅ Photo uploaded for <code>${esc(leased.ticketId)}</code>.\n✉️ Now reply to <b>this message</b> with the text to send with it (send <code>-</code> for no text).`, 'Text for the photo…');
      if (!r?.ok) { await store.releaseSession(chat, reply.message_id); await say('⚠️ Could not ask for the text. Reply with the photo again.'); return true; }
      await store.createSession(chat, r.result.message_id, { ticketId: leased.ticketId, step: 'caption', adminId: leased.adminId, photoUrl: url });
      await store.deleteSession(chat, reply.message_id);
      return true;
    }

    if (leased.step === 'caption') {
      if (!msg.text) { await store.releaseSession(chat, reply.message_id); await say('Please reply with <b>text</b> (or <code>-</code> for none).'); return true; }
      if ([...text].length > REPLY_MAX) { await store.releaseSession(chat, reply.message_id); await say(`Too long (max ${REPLY_MAX} characters). Reply again with a shorter text.`); return true; }
      const out = await store.addReply(leased.ticketId, { text: text === '-' ? '' : text, photoUrl: leased.photoUrl }, by);
      await store.deleteSession(chat, reply.message_id);
      await say(`✅ Photo${text === '-' ? '' : ' and text'} delivered to ticket <code>${esc(leased.ticketId)}</code>. Ticket is now <b>Solved</b>.`);
      await markReplied(out.ticket, by);
      return true;
    }
    await store.deleteSession(chat, reply.message_id);
    return true;
  } catch (e) {
    await store.releaseSession(chat, reply.message_id);
    if (e instanceof SupportError) { await say(`⚠️ ${esc(e.message)}`); if (e.status === 409) await store.deleteSession(chat, reply.message_id); }
    else { console.warn('[support] reply error:', redact(e).slice(0, 200)); await say('⚠️ Something went wrong. Please reply again.'); }
    return true;
  }
}
