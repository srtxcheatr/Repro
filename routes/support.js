// src by SRT X CHEATS. Copy right SRT X CHEATS
// /api/support/*  - website support tickets. Identity (uid, name, phone, email, IP) always comes from the verified
// Firebase token + the server's own user record; the browser only ever sends { type, description }.
import express from 'express';
import { asyncHandler } from '../src/asyncHandler.js';
import { requireFirebaseUid, userCors } from '../src/firebase.js';
import { getUserDoc } from '../src/userCache.js';
import { rateLimit, safeLog } from '../src/security.js';
import { store, SupportError, validateReport, toPublic, BUG_TYPES, DESC_MIN, DESC_MAX } from '../src/support.js';
import { announceTicket, announceCancelled } from '../src/supportBot.js';

const router = express.Router();
router.use(userCors);
// IP bucket first (cheap, protects token verification), then auth, then per-user buckets.
router.use(rateLimit({ windowMs: 60_000, max: 60, name: 'support-ip' }));
router.use(requireFirebaseUid);
const byUid = (req) => req.uid;
const readLimit = rateLimit({ windowMs: 60_000, max: 30, name: 'support-read', keyFn: byUid });
const createLimit = rateLimit({ windowMs: 10 * 60_000, max: 3, name: 'support-create', keyFn: byUid });
const cancelLimit = rateLimit({ windowMs: 10 * 60_000, max: 6, name: 'support-cancel', keyFn: byUid });

async function context(req) {
  const snap = await getUserDoc(req.uid);
  const d = snap.exists ? snap.data : {};
  return { uid: req.uid, name: d.profileName || '', phone: d.profilePhone || '', email: d.email || req.email || '', ip: req.ip || '' };
}

function fail(res, e, tag) {
  if (e instanceof SupportError) return res.status(e.status).json({ success: false, error: e.message, ...e.extra });
  safeLog(tag, e);
  return res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
}

// everything the page needs in one call
router.get('/overview', readLimit, asyncHandler(async (req, res) => {
  try {
    const [ctx, list] = await Promise.all([context(req), store.listTickets(req.uid)]);
    const tickets = list.map(toPublic);
    res.json({
      success: true,
      me: { uid: ctx.uid, name: ctx.name, phone: ctx.phone, email: ctx.email, ip: ctx.ip },
      limits: { min: DESC_MIN, max: DESC_MAX }, types: BUG_TYPES,
      pendingTicketId: tickets.find((t) => t.status === 'Pending')?.ticketId || null,
      tickets,
    });
  } catch (e) { fail(res, e, 'support:overview'); }
}));

// one ticket (the page polls this while a ticket is pending)
router.get('/tickets/:id', readLimit, asyncHandler(async (req, res) => {
  try {
    const t = await store.getOwned(req.uid, String(req.params.id));
    if (t.status === 'cancelled') return res.status(404).json({ success: false, error: 'Ticket not found.' });
    res.json({ success: true, ticket: toPublic(t) });
  } catch (e) { fail(res, e, 'support:get'); }
}));

router.post('/tickets', createLimit, asyncHandler(async (req, res) => {
  try {
    const report = validateReport(req.body);
    const ctx = await context(req);
    const ticket = await store.createTicket(req.uid, ctx, report);
    announceTicket(ticket).catch((e) => safeLog('support:announce', e));   // ticket is saved either way
    res.status(201).json({ success: true, ticket: toPublic(ticket) });
  } catch (e) { fail(res, e, 'support:create'); }
}));

router.post('/tickets/:id/cancel', cancelLimit, asyncHandler(async (req, res) => {
  try {
    const t = await store.cancelTicket(req.uid, String(req.params.id));
    announceCancelled(t).catch((e) => safeLog('support:cancel-announce', e));
    res.json({ success: true });
  } catch (e) { fail(res, e, 'support:cancel'); }
}));

export default router;
