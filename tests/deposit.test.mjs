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
// an EMPTY box is the only thing refused out loud; fake-format codes are handled silently further down
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

// ---- fake-format code: looks like a normal submit, then (5 s later) a strike notice - admin is never bothered ----
await d.collection('users').doc('FAKEUSER00000000000000000001').set({ email: 'f@b.com', profileName: 'Fake', profilePhone: '9811111111', balance: 0 });
const adminBefore = sent.filter((m) => m.bot === 'admin').length;
const t3 = (await dep.createDepositLink('FAKEUSER00000000000000000001')).split('dep_')[1];
await say(`/start dep_${t3}`); await say('500');
await say('1u7hmdy');                                                 // lowercase = fake format
assert.match(last().text, /Request received/);                          // same answer as a real payment
assert.doesNotMatch(last().text, /reject|invalid|too short|CAPITAL|starts with/i);
assert.equal(sent.filter((m) => m.bot === 'admin').length, adminBefore, 'admin must not be messaged for a fake code');
const fu = (await d.collection('users').doc('FAKEUSER00000000000000000001').get()).data();
assert.equal(fu.topupRequests[0].status, 'REJECTED'); assert.equal(fu.topupRequests[0].fake, true);
assert.equal(fu.fakePayment.count, 1); assert.match(fu.fakePayment.text, /Warning 1\/3/); assert.ok(!fu.ban, 'strike 1 is a warning only');
await new Promise((r) => setTimeout(r, 5400));
assert.match(last().text, /Deposit cancelled[\s\S]*Warning 1\/3/);       // strike notice arrives ~5 s later
// strike 2 = 1-day ban, strike 3 = permanent (same ladder as an admin Cancel)
const { createQrTopup } = await import('../src/topupQr.js');
let rr = await createQrTopup({ uid: 'FAKEUSER00000000000000000001', amount: 500, txCode: 'ABCDEFG', source: 'website' });
assert.equal(rr.ok, true); assert.equal(rr.status, 'PENDING');
let fu2 = (await d.collection('users').doc('FAKEUSER00000000000000000001').get()).data();
assert.equal(fu2.fakePayment.count, 2); assert.ok(fu2.banned && fu2.ban, 'strike 2 bans for 1 day');
rr = await createQrTopup({ uid: 'FAKEUSER00000000000000000001', amount: 500, txCode: '1abc', source: 'website' });
fu2 = (await d.collection('users').doc('FAKEUSER00000000000000000001').get()).data();
assert.equal(fu2.fakePayment.count, 3); assert.equal(Object.keys(rr).includes('autoRejected'), true);
assert.equal((await createQrTopup({ uid: 'FAKEUSER00000000000000000001', amount: 500, txCode: '', source: 'website' })).ok, false);   // empty box: visible error
console.log('deposit bot flow OK');
