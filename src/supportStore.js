// src by SRT X CHEATS. Copy right SRT X CHEATS
// Support tickets: pure data layer (Firestore). `getDb` is injected so the logic can be tested with a fake DB.
//
// Collections
//   supportTickets/{ticketId}   the ticket (doc id == ticket id, e.g. SRT_X_AB12CD34EF)
//   supportPending/{uid}        one doc per user that currently has a pending ticket (the concurrency lock)
//   supportSessions/{chat_msg}  one doc per open Telegram "reply to this message" prompt (see supportBot.js)
import crypto from 'node:crypto';

export const BUG_TYPES = ['Payment Issues', 'Product Problem', 'APK Update Not Found', 'Other'];
export const DESC_MIN = 10;
export const DESC_MAX = 50;
export const REPLY_MAX = 1000;
export const MAX_REPLIES = 20;
export const TICKET_RE = /^SRT_X_[A-Z0-9]{10}$/;
const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

export class SupportError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

export function newTicketId() {
  let s = '';
  for (let i = 0; i < 10; i++) s += ID_ALPHABET[crypto.randomInt(ID_ALPHABET.length)];
  return `SRT_X_${s}`;
}

// Single place that cleans free text: NFC, no control chars, single-line collapse for the user's description.
export function cleanText(v, { multiline = false } = {}) {
  let s = String(v ?? '').normalize('NFC');
  s = s.replace(multiline ? /[^\P{Cc}\n]/gu : /\p{Cc}/gu, ' ').replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '');
  s = multiline ? s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n') : s.replace(/\s+/g, ' ');
  return s.trim();
}
const len = (s) => [...s].length;

export function validateReport(body) {
  const type = body?.type;
  const raw = body?.description;
  if (typeof type !== 'string' || !BUG_TYPES.includes(type)) throw new SupportError(400, 'Choose a valid bug type.');
  if (typeof raw !== 'string') throw new SupportError(400, 'Please describe the problem.');
  const description = cleanText(raw);
  const n = len(description);
  if (n < DESC_MIN || n > DESC_MAX) throw new SupportError(400, `Description must be ${DESC_MIN}–${DESC_MAX} characters (now ${n}).`);
  if (!/[\p{L}\p{N}]/u.test(description)) throw new SupportError(400, 'Please describe the problem in words.');
  return { type, description };
}

export function validateReply({ text, photoUrl }) {
  const t = cleanText(text || '', { multiline: true });
  if (!t && !photoUrl) throw new SupportError(400, 'Reply is empty.');
  if (len(t) > REPLY_MAX) throw new SupportError(400, `Reply is too long (max ${REPLY_MAX} characters).`);
  if (photoUrl && !/^https:\/\/[^\s"'<>]+$/i.test(photoUrl)) throw new SupportError(400, 'Invalid photo URL.');
  return { text: t, photoUrl: photoUrl || '' };
}

// What the browser is allowed to see: never uid, ip, phone, telegram ids or admin identity.
export function toPublic(t) {
  return {
    ticketId: t.ticketId,
    type: t.type,
    description: t.description,
    status: t.status === 'solved' ? 'Solved' : 'Pending',
    createdAt: t.createdAt,
    solvedAt: t.solvedAt || null,
    replies: (t.replies || []).map((r) => ({ text: r.text || '', photoUrl: r.photoUrl || '', at: r.at })),
  };
}

export function makeStore(getDb) {
  const tickets = () => getDb().collection('supportTickets');
  const locks = () => getDb().collection('supportPending');
  const sessions = () => getDb().collection('supportSessions');

  // Creates a ticket unless the user already has a pending one. The lock doc + transaction make this
  // safe against double-clicks, two tabs and parallel requests: Firestore retries/aborts the loser.
  async function createTicket(uid, ctx, report) {
    const now = new Date().toISOString();
    for (let attempt = 0; attempt < 5; attempt++) {
      const ticketId = newTicketId();
      const ref = tickets().doc(ticketId);
      const lockRef = locks().doc(uid);
      try {
        return await getDb().runTransaction(async (tx) => {
          const lock = await tx.get(lockRef);
          if (lock.exists) {
            const cur = await tx.get(tickets().doc(String(lock.data().ticketId || '_')));
            if (cur.exists && cur.data().uid === uid && cur.data().status === 'pending') {
              throw new SupportError(409, 'You already have a pending ticket. Cancel it first to send a new report.', { pendingTicketId: cur.data().ticketId });
            }
          }
          if ((await tx.get(ref)).exists) throw new SupportError(500, '__id_collision');
          const doc = {
            ticketId, uid, type: report.type, description: report.description,
            name: ctx.name || '', phone: ctx.phone || '', email: ctx.email || '', ip: ctx.ip || '',
            status: 'pending', createdAt: now, solvedAt: null, cancelledAt: null, replies: [], tg: [],
          };
          tx.set(ref, doc);
          tx.set(lockRef, { ticketId, at: now });
          return doc;
        });
      } catch (e) {
        if (e instanceof SupportError && e.message === '__id_collision') continue;
        throw e;
      }
    }
    throw new SupportError(503, 'Could not create the ticket. Please try again.');
  }

  // Ownership is enforced here: a ticket that is not yours looks exactly like a ticket that does not exist.
  async function getOwned(uid, ticketId) {
    if (!TICKET_RE.test(ticketId)) throw new SupportError(404, 'Ticket not found.');
    const snap = await tickets().doc(ticketId).get();
    if (!snap.exists || snap.data().uid !== uid) throw new SupportError(404, 'Ticket not found.');
    return snap.data();
  }

  async function cancelTicket(uid, ticketId) {
    if (!TICKET_RE.test(ticketId)) throw new SupportError(404, 'Ticket not found.');
    const ref = tickets().doc(ticketId);
    const lockRef = locks().doc(uid);
    return getDb().runTransaction(async (tx) => {
      const [snap, lock] = await Promise.all([tx.get(ref), tx.get(lockRef)]);
      if (!snap.exists || snap.data().uid !== uid) throw new SupportError(404, 'Ticket not found.');
      const t = snap.data();
      if (t.status !== 'pending') throw new SupportError(409, t.status === 'solved' ? 'This ticket is already solved.' : 'This ticket is already cancelled.');
      const now = new Date().toISOString();
      tx.update(ref, { status: 'cancelled', cancelledAt: now });
      if (lock.exists && lock.data().ticketId === ticketId) tx.delete(lockRef);
      return { ...t, status: 'cancelled', cancelledAt: now };
    });
  }

  async function listTickets(uid, limit = 50) {
    let docs;
    try {
      docs = (await tickets().where('uid', '==', uid).orderBy('createdAt', 'desc').limit(limit).get()).docs;
    } catch (e) {
      // composite index (uid + createdAt) not created yet: fall back to an unordered read, sorted in memory
      if (e?.code !== 9 && !/index/i.test(String(e?.message))) throw e;
      docs = (await tickets().where('uid', '==', uid).limit(200).get()).docs;
    }
    return docs.map((d) => d.data())
      .filter((t) => t.status === 'pending' || t.status === 'solved')
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit);
  }

  // Admin reply (from Telegram). First reply flips Pending -> Solved and frees the user's pending slot.
  async function addReply(ticketId, reply, by = '') {
    if (!TICKET_RE.test(ticketId)) throw new SupportError(404, 'Ticket not found.');
    const r = validateReply(reply);
    const ref = tickets().doc(ticketId);
    return getDb().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new SupportError(404, 'Ticket not found.');
      const t = snap.data();
      if (t.status === 'cancelled') throw new SupportError(409, 'The user cancelled this ticket.');
      if ((t.replies || []).length >= MAX_REPLIES) throw new SupportError(429, 'Reply limit reached for this ticket.');
      const lockRef = locks().doc(t.uid);
      const lock = await tx.get(lockRef);
      const now = new Date().toISOString();
      const replies = [...(t.replies || []), { text: r.text, photoUrl: r.photoUrl, at: now, by: String(by).slice(0, 64) }];
      tx.update(ref, { replies, status: 'solved', solvedAt: t.solvedAt || now });
      if (lock.exists && lock.data().ticketId === ticketId) tx.delete(lockRef);
      return { ticket: { ...t, replies, status: 'solved', solvedAt: t.solvedAt || now }, firstSolve: t.status === 'pending' };
    });
  }

  const getTicket = async (ticketId) => {
    if (!TICKET_RE.test(ticketId)) return null;
    const s = await tickets().doc(ticketId).get();
    return s.exists ? s.data() : null;
  };
  const setTg = (ticketId, tg) => tickets().doc(ticketId).set({ tg }, { merge: true });

  // ---- Telegram prompt sessions: one per "reply to this message" prompt, so concurrent replies never mix ----
  const sessKey = (chatId, messageId) => `${chatId}_${messageId}`.replace(/[^\w-]/g, '_');
  const createSession = (chatId, messageId, data) =>
    sessions().doc(sessKey(chatId, messageId)).set({ ...data, chatId: String(chatId), exp: Date.now() + 15 * 60_000, busyUntil: 0 });
  const readSession = async (chatId, messageId) => {
    const s = await sessions().doc(sessKey(chatId, messageId)).get();
    return s.exists ? s.data() : null;
  };
  // Atomically marks a session busy for 60 s so a retried/duplicated update cannot be processed twice.
  async function leaseSession(chatId, messageId) {
    const ref = sessions().doc(sessKey(chatId, messageId));
    return getDb().runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists) return null;
      const d = s.data();
      if (d.exp < Date.now()) { tx.delete(ref); return null; }
      if (d.busyUntil > Date.now()) return null;
      tx.update(ref, { busyUntil: Date.now() + 60_000 });
      return d;
    });
  }
  const releaseSession = (chatId, messageId) => sessions().doc(sessKey(chatId, messageId)).set({ busyUntil: 0 }, { merge: true }).catch(() => {});
  const deleteSession = (chatId, messageId) => sessions().doc(sessKey(chatId, messageId)).delete().catch(() => {});

  return { createTicket, getOwned, cancelTicket, listTickets, addReply, getTicket, setTg, createSession, readSession, leaseSession, releaseSession, deleteSession };
}
