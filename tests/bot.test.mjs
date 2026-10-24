// Simulates Telegram + ImgBB with a fake fetch and drives the real supportBot.js
import assert from 'node:assert/strict';
process.env.TELEGRAM_TOPUP_AUTO_BOT = '123456789:AAFakeTokenFakeTokenFakeTokenFakeToken1';
process.env.TELEGRAM_TOPUP_AUTO_CHAT_ID = '-100';
process.env.TELEGRAM_TOPUP_ADMIN_IDS = '1,2';
process.env.IMGBB_API_KEY = 'imgbbsecretkey123456';
import { fakeDb } from './fakeDb.mjs';
import { makeStore } from '../src/supportStore.js';
const { store } = await import('../src/support.js');
const d = fakeDb(); Object.assign(store, makeStore(() => d));
const bot = await import('../src/supportBot.js');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]).toString('base64');
const sent = []; let mid = 1000; const uploads = [];
globalThis.fetch = async (url, opt) => {
  const u = String(url); const body = opt?.body && typeof opt.body === 'string' ? opt.body : '';
  const json = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o), arrayBuffer: async () => Buffer.from(PNG, 'base64') });
  if (u.includes('api.imgbb.com')) { uploads.push(new URLSearchParams(body)); return json({ success: true, data: { display_url: 'https://i.ibb.co/abc/photo.png' } }); }
  if (u.includes('/file/bot')) return json({});
  const method = u.split('/').pop(); const b = body ? JSON.parse(body) : {};
  if (method === 'sendMessage') { const m = { chat_id: b.chat_id, message_id: ++mid, ...b }; sent.push(m); return json({ ok: true, result: { message_id: mid, chat: { id: Number(b.chat_id) } } }); }
  if (method === 'getFile') return json({ ok: true, result: { file_path: 'photos/file_1.png' } });
  return json({ ok: true, result: true });
};
const ctx = { name: 'Ram', phone: '9800', email: 'r@x.com', ip: '1.1.1.1' }, rep = { type: 'Other', description: 'something is broken here' };
const t1 = await store.createTicket('u1', ctx, rep), t2 = await store.createTicket('u2', ctx, rep);
await bot.announceTicket(t1); await bot.announceTicket(t2);
const ann = sent.filter((m) => m.reply_markup?.inline_keyboard);
assert.equal(ann.length, 2);
assert.match(ann[0].text, /SRT_X_[A-Z0-9]{10}/); assert.deepEqual(ann[0].reply_markup.inline_keyboard[0].map((b) => b.text), ['Send Message', 'Send Photo']);
assert.ok(ann[0].reply_markup.inline_keyboard[0].every((b) => b.callback_data.length <= 64));
console.log('ok   announce formatting + buttons');

const cb = (data, from = 1) => ({ id: 'cb' + Math.random(), from: { id: from, username: 'adm' + from }, message: { chat: { id: -100 }, message_id: 1 }, data });
const press = async (action, t, from) => { const before = sent.length; await bot.handleSupportCallback(cb(`sp:${action}:${t.ticketId}`, from), `sp:${action}:${t.ticketId}`.match(bot.SUPPORT_CALLBACK_RE)); return sent.slice(before).find((m) => m.reply_markup?.force_reply && String(m.text).includes(t.ticketId)); };
const msg = (promptId, extra, from = 1) => ({ message_id: ++mid, chat: { id: -100 }, from: { id: from, username: 'adm' + from }, reply_to_message: { message_id: promptId }, ...extra });

// two admins press buttons on two different tickets at the same time
const [pA, pB] = await Promise.all([press('M', t1, 1), press('M', t2, 2)]);
assert.notEqual(pA.message_id, pB.message_id);
// replies arrive in the "wrong" order and in parallel
await Promise.all([bot.handleSupportMessage(msg(pB.message_id, { text: 'answer for ticket 2' }, 2)), bot.handleSupportMessage(msg(pA.message_id, { text: 'answer for ticket 1' }, 1))]);
assert.equal((await store.getTicket(t1.ticketId)).replies[0].text, 'answer for ticket 1');
assert.equal((await store.getTicket(t2.ticketId)).replies[0].text, 'answer for ticket 2');
assert.equal((await store.getTicket(t1.ticketId)).status, 'solved');
console.log('ok   concurrent admin replies reach the right ticket');

// duplicate delivery of the same update must not add two replies
const t3 = await store.createTicket('u3', ctx, rep); await bot.announceTicket(t3);
const p3 = await press('M', t3, 1);
const dup = msg(p3.message_id, { text: 'once only' });
await Promise.all([bot.handleSupportMessage(dup), bot.handleSupportMessage(dup), bot.handleSupportMessage(dup)]);
assert.equal((await store.getTicket(t3.ticketId)).replies.length, 1);
console.log('ok   duplicate webhook deliveries are idempotent');

// someone else (or a non-reply) cannot hijack a prompt
const t4 = await store.createTicket('u4', ctx, rep); await bot.announceTicket(t4);
const p4 = await press('M', t4, 1);
assert.equal(await bot.handleSupportMessage(msg(p4.message_id, { text: 'hijack' }, 99)), false);   // not an allowed admin
await bot.handleSupportMessage(msg(p4.message_id, { text: 'hijack' }, 2));                         // allowed admin but not the owner of the prompt
assert.equal((await store.getTicket(t4.ticketId)).replies.length, 0);
assert.equal(await bot.handleSupportMessage({ message_id: 5, chat: { id: -100 }, from: { id: 1 }, text: '/addbalance' }), false);
console.log('ok   prompt ownership + normal commands untouched');

// photo flow: photo -> imgbb (server-side key) -> asks for text -> delivers both
const pp = await press('P', t4, 1);
const before = sent.length;
await bot.handleSupportMessage(msg(pp.message_id, { photo: [{ file_id: 'small', file_size: 1000 }, { file_id: 'big', file_size: 50000 }] }));
assert.equal(uploads.length, 1); assert.equal(uploads[0].get('key'), 'imgbbsecretkey123456');
const capPrompt = sent.slice(before).find((m) => m.reply_markup?.force_reply);
assert.ok(capPrompt && /text/i.test(capPrompt.text));
assert.equal((await store.getTicket(t4.ticketId)).replies.length, 0);                              // nothing delivered before the text
await bot.handleSupportMessage(msg(capPrompt.message_id, { text: 'see the screenshot' }));
const r = (await store.getTicket(t4.ticketId)).replies[0];
assert.deepEqual([r.text, r.photoUrl], ['see the screenshot', 'https://i.ibb.co/abc/photo.png']);
console.log('ok   photo flow end to end');

// non-image document is rejected and the prompt stays usable
const t5 = await store.createTicket('u5', ctx, rep); await bot.announceTicket(t5);
const p5 = await press('P', t5, 1);
await bot.handleSupportMessage(msg(p5.message_id, { document: { file_id: 'x', mime_type: 'application/x-msdownload', file_size: 10 } }));
assert.equal(uploads.length, 1);
assert.ok(await store.readSession(-100, p5.message_id));
console.log('ok   non-image rejected, session kept');

// buttons on a cancelled ticket
const t6 = await store.createTicket('u6', ctx, rep); await store.cancelTicket('u6', t6.ticketId);
assert.equal(await press('M', t6, 1), undefined);
// outsiders pressing buttons
const n = sent.length; await bot.handleSupportCallback(cb(`sp:M:${t5.ticketId}`, 1), `sp:M:${t5.ticketId}`.match(bot.SUPPORT_CALLBACK_RE));
const wrongChat = cb(`sp:M:${t5.ticketId}`); wrongChat.message.chat.id = -999; const n2 = sent.length;
await bot.handleSupportCallback(wrongChat, wrongChat.data.match(bot.SUPPORT_CALLBACK_RE)); assert.equal(sent.length, n2);
console.log('ok   cancelled ticket + wrong chat blocked');
console.log('\nall bot tests passed');
