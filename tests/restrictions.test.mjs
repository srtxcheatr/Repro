// /removeallrestriction: drives the real telegramBot.js with a fake Telegram and an in-memory Firestore
import assert from 'node:assert/strict';
process.env.TELEGRAM_TOPUP_AUTO_BOT = '123456789:AAFakeTokenFakeTokenFakeTokenFakeToken1';
process.env.TELEGRAM_TOPUP_AUTO_CHAT_ID = '-100';
process.env.TELEGRAM_TOPUP_ADMIN_IDS = '1';
process.env.FIREBASE_SERVICE_ACCOUNT_JSON = '{}';
import admin from 'firebase-admin';
import { fakeDb } from './fakeDb.mjs';
const d = fakeDb();
// the in-memory db has no FieldValue.delete(): make set(..., {merge:true}) understand the marker (test only)
const realCollection = d.collection.bind(d);
d.collection = (c) => {
  const col = realCollection(c); const realDoc = col.doc.bind(col);
  col.doc = (id) => {
    const ref = realDoc(id); const rawSet = ref.set.bind(ref); const rawGet = ref.get.bind(ref);
    ref.get = async () => ({ ...(await rawGet()), id });
    ref.set = async (v, o) => {
      if (!o?.merge) return rawSet(v);
      const m = { ...((await ref.get()).data() || {}) };
      for (const [k, val] of Object.entries(v)) { if (val === '__DELETE__') delete m[k]; else m[k] = val; }
      return rawSet(m);
    };
    return ref;
  };
  return col;
};
admin.initializeApp = () => ({}); admin.credential = { cert: () => ({}) };
admin.firestore = Object.assign(() => d, { FieldValue: { delete: () => '__DELETE__' } });
const sent = []; let mid = 10;
globalThis.fetch = async (url, opt) => {
  const method = String(url).split('/').pop(); const b = opt?.body ? JSON.parse(opt.body) : {};
  sent.push({ method, ...b });
  return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: ++mid, chat: { id: -100 } } }) };
};
const bot = await import('../src/telegramBot.js');
const say = (text) => bot.handleMessage({ chat: { id: -100, type: 'supergroup' }, from: { id: 1, username: 'adm' }, text });
const last = () => sent.filter((m) => m.method === 'sendMessage').at(-1);

// a user with every kind of restriction
await d.collection('users').doc('U1').set({
  email: 'r@x.com', profileName: 'Ram', balance: 70, requestStatus: 'Banned',
  ban: { permanent: true, until: null, label: 'Permanent', at: 1, by: 'topup-auto' }, banned: true,
  fakePayment: { count: 3, lastAt: new Date().toISOString(), lastTx: 'abc', text: 'Warning 3/3' },
  topupRequests: [{ status: 'REJECTED', amount: 100, txCode: 'abc', fake: true }],
});
await d.collection('users').doc('U2').set({ email: 'clean@x.com', profileName: 'Clean', balance: 5 });

// clean account -> nothing to remove, no buttons
await say('/removeallrestriction U2');
assert.match(last().text, /no restrictions/); assert.ok(!last().reply_markup);

// restricted account -> lists what will go, asks for confirmation
await say('/remove_all_restriction U1');                           // the underscore spelling works too
assert.match(last().text, /Ban - Permanent[\s\S]*Reseller API suspended[\s\S]*strikes 3\/3[\s\S]*Remove ALL/);
const btns = last().reply_markup.inline_keyboard[0];
assert.deepEqual(btns.map((b) => b.text), ['Remove all', 'Cancel']); assert.deepEqual(btns.map((b) => b.style), ['success', 'danger']);
assert.ok(btns.every((b) => b.callback_data.length <= 64 && bot.BOT_CALLBACK_RE.test(b.callback_data)));
assert.equal((await d.collection('users').doc('U1').get()).data().fakePayment.count, 3, 'nothing changes before confirming');

// Cancel leaves everything as it was
await bot.handleBotCallback({ id: 'c1', from: { id: 1 }, message: { chat: { id: -100 }, message_id: 5, text: 'x' }, data: btns[1].callback_data });
assert.equal((await d.collection('users').doc('U1').get()).data().fakePayment.count, 3);

// confirm
await say('/removeallrestriction U1');
const ok = last().reply_markup.inline_keyboard[0][0].callback_data;
await bot.handleBotCallback({ id: 'c2', from: { id: 1 }, message: { chat: { id: -100 }, message_id: 6, text: 'x' }, data: ok });
const u = (await d.collection('users').doc('U1').get()).data();
assert.ok(!u.ban && !u.banned && !u.fakePayment, 'ban, banned flag and strikes are gone');
assert.equal(u.requestStatus, 'Active'); assert.equal(u.balance, 70, 'balance untouched');
assert.equal(u.topupRequests.length, 1, 'top-up history kept');
assert.match(u.adminLog.at(-1).note, /All restrictions removed/);
assert.ok(sent.some((m) => m.method === 'editMessageText' && /ALL RESTRICTIONS REMOVED/.test(m.text)));
// the button is single-use
await bot.handleBotCallback({ id: 'c3', from: { id: 1 }, message: { chat: { id: -100 }, message_id: 6, text: 'x' }, data: ok });
assert.ok(sent.some((m) => m.method === 'answerCallbackQuery' && /Expired/.test(m.text)));
await say('/removeallrestriction U1'); assert.match(last().text, /no restrictions/);
console.log('removeallrestriction OK');
