// Drives the real depositBot.js + createQrTopup with a fake Telegram and an in-memory Firestore
import assert from 'node:assert/strict';
process.env.TELEGRAM_DEPOSIT_BOT_TOKEN = '111:AAFakeDepositTokenFakeDepositToken12345';
process.env.TELEGRAM_DEPOSIT_BOT_USERNAME = 'SRTXDepositBot';
process.env.TELEGRAM_TOPUP_AUTO_BOT = '123456789:AAFakeTokenFakeTokenFakeTokenFakeToken1';
process.env.TELEGRAM_TOPUP_AUTO_CHAT_ID = '-100';
process.env.FIREBASE_SERVICE_ACCOUNT_JSON = '{}';
import admin from 'firebase-admin';
import { fakeDb } from './fakeDb.mjs';
const d = fakeDb();
admin.initializeApp = () => ({}); admin.credential = { cert: () => ({}) }; admin.firestore = () => d;

process.env.SITE_URL = 'https://www.srtxcheats.com';
const sent = [];
globalThis.fetch = async (url, opt) => {
  if (!String(url).includes('api.telegram.org')) {               // the backend fetching the QR image from the website
    if (String(url).endsWith('/assets/img/srtx-pay-qr.jpg')) {
      return { ok: true, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => Buffer.from('fake-qr-bytes') };
    }
    return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => Buffer.alloc(0) };
  }
  const method = String(url).split('/').pop();
  const bot = String(url).includes('/bot111:') ? 'deposit' : 'admin';
  let b;
  if (opt?.body instanceof FormData) {                            // multipart upload (sendPhoto)
    b = {}; let fileField = null;
    for (const [k, v] of opt.body.entries()) { if (v instanceof Blob) fileField = k; else b[k] = v; }
    b.photo = fileField ? 'uploaded:srtx-pay-qr.jpg' : undefined;
  } else {
    b = opt?.body ? JSON.parse(opt.body) : {};
  }
  sent.push({ bot, method, ...b });
  return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1, chat: { id: Number(b.chat_id) || 0 }, username: 'SRTXDepositBot' } }) };
};
const dep = await import('../src/depositBot.js');
await d.collection('users').doc('UID123456789012345678901234').set({ email: 'a@b.com', profileName: 'Ram', profilePhone: '9800000000', balance: 10 });

const url = await dep.createDepositLink('UID123456789012345678901234');
assert.match(url, /^https:\/\/t\.me\/SRTXDepositBot\?start=dep_[A-Za-z0-9_-]{12}$/);
const token = url.split('dep_')[1];
const say = (text) => dep.handleDepositUpdate({ message: { chat: { id: 55, type: 'private' }, from: { id: 55 }, text } });
const last = (bot = 'deposit') => sent.filter((m) => m.bot === bot).at(-1);

await say('/start');                                        // no token -> instructions only
assert.match(last().text, /Deposit via Telegram/);

// if the website can't be reached, the bot still starts the flow with a plain message (no crash, no stuck chat)
// (must run before any successful fetch, since a good QR image is then cached for later deposits)
process.env.DEPOSIT_QR_URL = 'https://example.invalid/missing.jpg';
await say(`/start dep_${token}`);
assert.match(last().text, /Could not load the QR image right now[\s\S]*Enter amount of deposit/);
delete process.env.DEPOSIT_QR_URL;
await say('/cancel');

const t1 = (await dep.createDepositLink('UID123456789012345678901234')).split('dep_')[1];
await say(`/start dep_${t1}`);
const card = sent.find((m) => m.method === 'sendMessage' && /Uid - UID123/.test(m.text || ''));
assert.ok(card, 'details card'); assert.match(card.text, /Email - a@b.com[\s\S]*Name - Ram[\s\S]*Number - 9800000000[\s\S]*I want to get deposit balance/);
const photo = sent.find((m) => m.method === 'sendPhoto'); assert.match(photo.caption, /Welcome to SRT X CHEATS[\s\S]*Enter amount of deposit/);
assert.match(photo.photo, /srtx-pay-qr\.jpg$/);
await say(`/start dep_${t1}`);                              // link is one-time
assert.match(last().text, /expired/);

await say('abc'); assert.match(last().text, /valid amount/);
await say('50');  assert.match(last().text, /valid amount/);
await say('500'); assert.match(last().text, /Send transaction code[\s\S]*Esewa[\s\S]*NRP 500[\s\S]*no refunds/);
assert.doesNotMatch(last().text, /1U7HMDY|example|7 char|capital/i);   // the format is never shown to the user
// every bad code is rejected at once with the SAME generic message (no rule is revealed) and nothing reaches the admin bot
const adminBefore = sent.filter((m) => m.bot === 'admin').length;
for (const bad of ['x', '1u7hmdy', '0U7HMDY', '1U7HMD', '1U7HMDYY', '1U7-HMD', 'ABCDEFG']) {
  await say(bad);
  assert.match(last().text, /Payment rejected: this transaction code is not valid/, `"${bad}" must be rejected`);
  assert.doesNotMatch(last().text, /too short|too long|CAPITAL|starts with|7 char|example/i, 'rejection must not leak the rules');
}
assert.equal(sent.filter((m) => m.bot === 'admin').length, adminBefore, 'fake codes must never be sent to the admin');
assert.equal(((await d.collection('users').doc('UID123456789012345678901234').get()).data().topupRequests || []).length, 0, 'fake codes must not be stored');
await say('1U7HMDY');
assert.match(last().text, /Request received/);
const adminMsg = last('admin'); assert.match(adminMsg.text, /USER NAME<\/b> - Ram[\s\S]*REQUEST BALANCE[\s\S]*NRP 500[\s\S]*1U7HMDY[\s\S]*Telegram deposit bot/);
assert.deepEqual(adminMsg.reply_markup.inline_keyboard[0].map((b) => b.text), ['Load', 'Cancel']);
assert.deepEqual(adminMsg.reply_markup.inline_keyboard[0].map((b) => b.style), ['success', 'danger']);
const u = (await d.collection('users').doc('UID123456789012345678901234').get()).data();
assert.equal(u.topupRequests[0].status, 'PENDING'); assert.equal(u.topupRequests[0].source, 'telegram');
const idx = (await d.collection('topupQr').doc(u.topupRequests[0].reqId).get()).data(); assert.ok(idx.tgChatId === '55');

// duplicate tx code is rejected on a new deposit
const t2 = (await dep.createDepositLink('UID123456789012345678901234')).split('dep_')[1];
await say(`/start dep_${t2}`); await say('500'); await say('1U7HMDY'); assert.match(last().text, /already submitted/);
console.log('deposit bot flow OK');
