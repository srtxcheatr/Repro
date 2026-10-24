// Run: node tests/support.test.mjs   (no dependencies - uses an in-memory Firestore with optimistic transactions)
import assert from 'node:assert/strict';
import { makeStore, validateReport, newTicketId, TICKET_RE, toPublic, SupportError } from '../src/supportStore.js';

import { fakeDb } from './fakeDb.mjs';

const ctx = { name: 'Ram', phone: '9800000000', email: 'r@x.com', ip: '1.2.3.4' };
const ok = { type: 'Payment Issues', description: 'Balance not added after payment' };
let n = 0; const t = (name, fn) => fn().then(() => console.log('ok  ', ++n, name)).catch((e) => { console.error('FAIL', name, e); process.exit(1); });

await t('ticket id format + uniqueness', async () => {
  const ids = new Set(Array.from({ length: 2000 }, newTicketId));
  assert.equal(ids.size, 2000); for (const i of ids) assert.match(i, TICKET_RE); assert.equal([...ids][0].length, 16);
});
await t('validation: type / length 10-50 / control chars', async () => {
  assert.throws(() => validateReport({ type: 'Hack', description: ok.description }), SupportError);
  assert.throws(() => validateReport({ type: ok.type, description: 'too short' }), /10/);            // 9 chars
  assert.doesNotThrow(() => validateReport({ type: ok.type, description: '1234567890' }));          // 10
  assert.doesNotThrow(() => validateReport({ type: ok.type, description: 'x'.repeat(50) }));        // 50
  assert.throws(() => validateReport({ type: ok.type, description: 'x'.repeat(51) }), /50/);
  assert.throws(() => validateReport({ type: ok.type, description: '          a         ' }), /10/); // padding does not count
  assert.throws(() => validateReport({ type: ok.type, description: ['a'.repeat(20)] }), SupportError);
  assert.equal(validateReport({ type: ok.type, description: 'line1\n\n\tline2 ok!!' }).description, 'line1 line2 ok!!');
  assert.throws(() => validateReport({ type: ok.type, description: '!!!!!!!!!!!!' }), /words/);
});
await t('only ONE pending ticket under 20 parallel requests', async () => {
  const fakeDb2 = fakeDb(); const st = makeStore(() => fakeDb2);
  const res = await Promise.allSettled(Array.from({ length: 20 }, () => st.createTicket('u1', ctx, ok)));
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 1);
  assert.ok(res.filter((r) => r.status === 'rejected').every((r) => r.reason.status === 409));
  assert.equal([...fakeDb2._data.keys()].filter((k) => k.startsWith('supportTickets/')).length, 1);
});
await t('different users do not block each other', async () => {
  const d = fakeDb(); const st = makeStore(() => d);
  await Promise.all([st.createTicket('a', ctx, ok), st.createTicket('b', ctx, ok)]);
});
await t('cancel frees the slot; ownership enforced; no double cancel', async () => {
  const d = fakeDb(); const st = makeStore(() => d);
  const a = await st.createTicket('a', ctx, ok);
  await assert.rejects(st.cancelTicket('b', a.ticketId), (e) => e.status === 404);          // someone else's ticket
  await assert.rejects(st.getOwned('b', a.ticketId), (e) => e.status === 404);
  await assert.rejects(st.cancelTicket('a', 'SRT_X_../../etc'), (e) => e.status === 404);   // malformed id
  await assert.rejects(st.createTicket('a', ctx, ok), (e) => e.status === 409 && e.extra.pendingTicketId === a.ticketId);
  await st.cancelTicket('a', a.ticketId);
  await assert.rejects(st.cancelTicket('a', a.ticketId), (e) => e.status === 409);
  const b = await st.createTicket('a', ctx, ok); assert.notEqual(b.ticketId, a.ticketId);
  assert.deepEqual((await st.listTickets('a')).map((x) => x.ticketId), [b.ticketId]);        // cancelled hidden
});
await t('cancel vs create race never leaves 2 pending', async () => {
  const d = fakeDb(); const st = makeStore(() => d);
  const a = await st.createTicket('a', ctx, ok);
  await Promise.allSettled([st.cancelTicket('a', a.ticketId), st.createTicket('a', ctx, ok), st.createTicket('a', ctx, ok)]);
  assert.ok((await st.listTickets('a')).filter((x) => x.status === 'pending').length <= 1);
});
await t('admin reply solves ticket, frees slot, cancelled tickets reject replies', async () => {
  const d = fakeDb(); const st = makeStore(() => d);
  const a = await st.createTicket('a', ctx, ok);
  const r = await st.addReply(a.ticketId, { text: 'Fixed, check now', photoUrl: 'https://i.ibb.co/x/y.jpg' }, '@admin');
  assert.equal(r.firstSolve, true); assert.equal(r.ticket.status, 'solved');
  const r2 = await st.addReply(a.ticketId, { text: 'more' }, '@admin'); assert.equal(r2.firstSolve, false);
  const pub = toPublic((await st.listTickets('a'))[0]);
  assert.equal(pub.status, 'Solved'); assert.equal(pub.replies.length, 2); assert.equal(pub.replies[0].photoUrl, 'https://i.ibb.co/x/y.jpg');
  assert.ok(!('uid' in pub) && !('ip' in pub) && !('phone' in pub) && !('by' in pub.replies[0]));    // nothing private leaks
  await st.createTicket('a', ctx, ok);                                                               // slot is free again
  const c = await st.createTicket('z', ctx, ok); await st.cancelTicket('z', c.ticketId);
  await assert.rejects(st.addReply(c.ticketId, { text: 'x' }), (e) => e.status === 409);
  await assert.rejects(st.addReply(a.ticketId, { photoUrl: 'javascript:alert(1)', text: 'x' }), (e) => e.status === 400);
});
await t('concurrent admin sessions map to the right tickets', async () => {
  const d = fakeDb(); const st = makeStore(() => d);
  const [a, b] = await Promise.all([st.createTicket('a', ctx, ok), st.createTicket('b', ctx, ok)]);
  await st.createSession(-100, 11, { ticketId: a.ticketId, step: 'text', adminId: '1' });
  await st.createSession(-100, 12, { ticketId: b.ticketId, step: 'text', adminId: '2' });
  assert.equal((await st.readSession(-100, 11)).ticketId, a.ticketId);
  assert.equal((await st.readSession(-100, 12)).ticketId, b.ticketId);
  assert.equal(await st.readSession(-100, 13), null);
  const leases = await Promise.all([st.leaseSession(-100, 11), st.leaseSession(-100, 11), st.leaseSession(-100, 11)]);
  assert.equal(leases.filter(Boolean).length, 1);                                                    // duplicate webhook is ignored
  await st.releaseSession(-100, 11); assert.ok(await st.leaseSession(-100, 11));
});
await t('images: max 3, strings only, optional; attachments are public, https only', async () => {
  assert.deepEqual(validateReport(ok).images, []);
  assert.equal(validateReport({ ...ok, images: ['a', 'b', 'c'] }).images.length, 3);
  assert.throws(() => validateReport({ ...ok, images: ['a', 'b', 'c', 'd'] }), /up to 3/);
  assert.throws(() => validateReport({ ...ok, images: [123] }), SupportError);
  assert.throws(() => validateReport({ ...ok, images: 'x' }), SupportError);
  const d = fakeDb(); const st = makeStore(() => d);
  const a = await st.createTicket('a', ctx, { ...ok, attachments: ['https://i.ibb.co/1.jpg', 'javascript:alert(1)'] });
  assert.deepEqual(toPublic(a).attachments, ['https://i.ibb.co/1.jpg']);
});
await t('only 2 cancels per window, then 429; solved tickets are not affected', async () => {
  const d = fakeDb(); const st = makeStore(() => d);
  assert.equal((await st.getCancelInfo('a')).left, 2);
  for (let i = 0; i < 2; i++) { const x = await st.createTicket('a', ctx, ok); await st.cancelTicket('a', x.ticketId); }
  const info = await st.getCancelInfo('a'); assert.equal(info.left, 0); assert.ok(info.resetAt);
  const third = await st.createTicket('a', ctx, ok);
  await assert.rejects(st.cancelTicket('a', third.ticketId), (e) => e.status === 429 && e.extra.cancels.left === 0);
  assert.equal(await st.getPendingId('a'), third.ticketId);                  // still pending, nothing was cancelled
  await st.addReply(third.ticketId, { text: 'done' }, '@admin');             // admin can still solve it
  assert.equal(await st.getPendingId('a'), null);
  assert.equal((await st.getCancelInfo('b')).left, 2);                       // other users unaffected
});
await t('cancel window expires', async () => {
  const d = fakeDb(); const st = makeStore(() => d);
  const old = new Date(Date.now() - 25 * 3_600_000).toISOString();
  await d.collection('supportCancels').doc('a').set({ times: [old, old] });
  assert.equal((await st.getCancelInfo('a')).left, 2);
});
console.log('\nall support tests passed');
