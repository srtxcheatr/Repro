import express from 'express';
import admin from 'firebase-admin';
import { asyncHandler } from '../src/asyncHandler.js';
import { db, requireFirebaseUid, userCors } from '../src/firebase.js';
import { rateLimit } from '../src/security.js';
import { telegramNotify, esc } from '../src/telegram.js';
import { invalidateUserDoc } from '../src/userCache.js';
import { gloryCall, gloryConfigured, serialized, getRegions, nrpPriceForTier, GloryError } from '../src/glory.js';

const router = express.Router();
router.use(userCors);
router.use(requireFirebaseUid);

const COL = 'gloryGroups';
const maxGroups = () => Math.max(1, Number(process.env.GLORY_MAX_GROUPS_PER_USER || 5));

// One launch at a time per user — stops a double-click / double-tab from
// charging NRP twice.
const launching = new Set();

// Be tolerant about how the upstream names the new group's id.
function pickId(o) {
  if (!o || typeof o !== 'object') return '';
  const v = o.group_id || o.groupId || o.id
    || (o.group && (o.group.group_id || o.group.id))
    || (o.data && (o.data.group_id || o.data.id));
  return v ? String(v) : '';
}

// Fallback: newest upstream group for this clan that we haven't recorded yet.
async function findNewGroup(clanId) {
  const list = await gloryCall('GET', '/api/client/my-groups');
  const cands = (Array.isArray(list) ? list : [])
    .filter((g) => String(g.clan_id) === clanId)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  for (const g of cands) {
    const known = await db().collection(COL).doc(String(g.group_id)).get();
    if (!known.exists) return String(g.group_id);
  }
  return '';
}

function fail(res, e) {
  if (e instanceof GloryError) return res.status(e.status >= 400 && e.status < 600 ? e.status : 502).json({ success: false, error: e.message });
  throw e;
}


// Live clan details. We don't have a written spec for the reply of
// get-glory / get-clan-info, so each field is looked up under the names
// the panel is known to use, plus a few close variants.
function dig(o, keys, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 3) return undefined;
  for (const k of keys) {
    const v = o[k];
    if (v !== undefined && v !== null && typeof v !== 'object') return v;
  }
  for (const v of Object.values(o)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const r = dig(v, keys, depth + 1);
      if (r !== undefined) return r;
    }
  }
  return undefined;
}
// Flatten any reply into { key: primitive } for the Details popup.
function flat(o, prefix = '', out = {}, depth = 0) {
  if (o === null || o === undefined) return out;
  if (typeof o !== 'object') { out[prefix || 'value'] = o; return out; }
  if (depth > 2) return out;
  for (const [k, v] of Object.entries(o)) {
    if (Object.keys(out).length >= 40) break;
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) out[prefix + k] = v.every((x) => typeof x !== 'object') ? v.join(', ') : `${v.length} items`;
    else if (typeof v === 'object') flat(v, prefix + k + '.', out, depth + 1);
    else out[prefix + k] = v;
  }
  return out;
}


// Clan emblem. Prefer a ready-made image URL from the reply; otherwise a
// numeric badge id plus GLORY_BADGE_URL_TEMPLATE (e.g. https://cdn.example/{id}.png).
function pickLogo(...sources) {
  const urls = []; const ids = [];
  const walk = (o, depth = 0) => {
    if (!o || typeof o !== 'object' || depth > 3) return;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' && /^https?:\/\//i.test(v) && /logo|badge|emblem|icon|avatar|image|img|pic/i.test(k)) urls.push(v.replace(/^http:/i, 'https:'));
      else if ((typeof v === 'number' || /^\d{1,12}$/.test(String(v))) && /badge|logo|emblem/i.test(k)) ids.push(String(v));
      else if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, depth + 1);
    }
  };
  sources.forEach((s) => walk(s));
  const badgeId = ids[0] || '';
  if (urls[0]) return { logoUrl: urls[0], badgeId };
  const tpl = process.env.GLORY_BADGE_URL_TEMPLATE;
  if (tpl && badgeId) return { logoUrl: tpl.replace('{id}', encodeURIComponent(badgeId)), badgeId };
  return { logoUrl: '', badgeId };
}

// Latest glory snapshot from the documented glory-progression endpoint.
// Cached longer than the live info: snapshots only change about once an hour.
const snapCache = new Map();
async function lastSnapshot(groupId) {
  const hit = snapCache.get(groupId);
  if (hit && Date.now() - hit.at < 300_000) return hit.data;
  const out = await serialized(() => gloryCall('GET', '/api/client/glory-progression', { query: { group_id: groupId }, timeoutMs: 20000 }));
  const list = Array.isArray(out?.snapshots) ? out.snapshots : [];
  const a = list[list.length - 1];
  const b = list[list.length - 2];
  const data = a ? {
    at: a.captured_at, glory: a.total_glory,
    gained: b ? Number(a.total_glory) - Number(b.total_glory) : null,
    farmed: out.glory_farmed,
  } : null;
  snapCache.set(groupId, { at: Date.now(), data });
  return data;
}

const detailsCache = new Map(); // groupId -> { at, data }
const DETAILS_TTL = 40_000;
let loggedShape = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every call to the upstream group-action endpoint goes through ONE queue
// (the reseller account is shared; parallel calls give 409 "operation in
// progress"). A 409 is retried twice after a short pause.
function groupAction(action, groupId, timeoutMs = 30000) {
  return serialized(async () => {
    for (let i = 0; ; i++) {
      try {
        const out = await gloryCall('POST', '/api/client/group-action', { body: { action, group_id: groupId }, timeoutMs });
        if (out && typeof out === 'object' && (out.success === false || (out.error && out.success !== true))) {
          throw new GloryError(String(out.error || 'Service returned an error.'), { status: 502 });
        }
        return out;
      } catch (e) {
        if (e instanceof GloryError && e.status === 409 && i < 2) { await sleep(1500); continue; }
        throw e;
      }
    }
  });
}
const errText = (e) => (e instanceof GloryError ? `${e.message}${e.status ? ` (HTTP ${e.status})` : ''}` : 'Unexpected error');

async function loadDetails(groupId, fresh = false) {
  const hit = detailsCache.get(groupId);
  if (!fresh && hit && Date.now() - hit.at < DETAILS_TTL) return hit.data;

  const errors = {};
  let g = null; let c = null;
  try { g = await groupAction('get-glory', groupId); } catch (e) { errors.glory = errText(e); }
  try { c = await groupAction('get-clan-info', groupId); } catch (e) { errors.clan = errText(e); }

  let snap = null;
  try { snap = await lastSnapshot(groupId); } catch (_) { /* optional */ }

  if (g === null && c === null) {
    if (hit) return { ...hit.data, stale: true, errors };
    const err = new GloryError(`Live info unavailable — ${Object.entries(errors).map(([k, v]) => `${k}: ${v}`).join('; ')}`, { status: 502 });
    throw err;
  }

  const gloryVal = typeof g === 'number' ? g : dig(g, ['glory', 'total_glory', 'points', 'score', 'clan_glory']);
  if (!loggedShape) {
    loggedShape = true;
    console.log('[glory] clan-info fields:', Object.keys(flat(c)).join(', '));
    console.log('[glory] glory fields:', Object.keys(flat(typeof g === 'object' ? g : {})).join(', '));
  }
  const data = {
    clanName: dig(c, ['clan_name', 'clanName', 'name', 'guild_name', 'guildName']) ?? dig(g, ['clan_name', 'clanName']),
    level: dig(c, ['clan_level', 'clanLevel', 'guild_level', 'level']),
    members: dig(c, ['member_num', 'member_count', 'memberCount', 'members', 'current_members', 'memberNum']),
    capacity: dig(c, ['capacity', 'member_capacity', 'max_members', 'maxMembers', 'max_member', 'maxMember']),
    captain: dig(c, ['captain_id', 'captainId', 'captain', 'leader_id', 'leader']),
    glory: gloryVal ?? dig(c, ['glory', 'total_glory', 'clan_glory', 'score']) ?? (snap ? snap.glory : undefined),
    lastSnap: snap,
    games: dig(g, ['games', 'games_played', 'matches', 'match_count', 'matches_played', 'total_games', 'total_matches'])
      ?? dig(c, ['games', 'matches']),
    since: dig(g, ['since', 'last_match_at', 'last_match_time', 'last_match', 'last_match_since'])
      ?? dig(c, ['since', 'last_match_at']),
    ...pickLogo(c, g),
    clan: flat(c),
    gloryInfo: flat(typeof g === 'object' ? g : { glory: g }),
    errors,
    updatedAt: new Date().toISOString(),
  };
  detailsCache.set(groupId, { at: Date.now(), data });
  return data;
}

async function ownGroup(req, res) {
  const gid = String(req.query.group_id || '').trim();
  if (!gid) { res.status(400).json({ success: false, error: 'Missing group_id.' }); return null; }
  const doc = await db().collection(COL).doc(gid).get();
  if (!doc.exists || doc.data().uid !== req.uid || doc.data().status === 'deleted') {
    res.status(404).json({ success: false, error: 'Group not found.' });
    return null;
  }
  return doc.data();
}

// GET /api/glory/regions — enabled regions with the NRP price for each.
router.get('/regions', asyncHandler(async (req, res) => {
  try {
    const p = await getRegions();
    const regions = (p.regions || [])
      .filter((r) => r.enabled)
      .map((r) => ({
        id: r.id, name: r.region_name, code: r.region_code, tier: r.tier,
        priceNrp: nrpPriceForTier(r.tier),
      }));
    res.json({ success: true, configured: gloryConfigured(), regions, maxGroups: maxGroups() });
  } catch (e) { return fail(res, e); }
}));

// GET /api/glory/groups — only THIS user's groups, merged with live status.
router.get('/groups', asyncHandler(async (req, res) => {
  const snap = await db().collection(COL).where('uid', '==', req.uid).get();
  const mine = snap.docs.map((d) => d.data()).filter((g) => g.status !== 'deleted');

  let live = new Map();
  if (mine.length && gloryConfigured()) {
    try {
      const list = await gloryCall('GET', '/api/client/my-groups');
      live = new Map((Array.isArray(list) ? list : []).map((g) => [g.group_id, g]));
    } catch (_) { /* show stored data if the upstream is down */ }
  }

  const groups = mine.map((g) => {
    const l = live.get(g.groupId);
    const botCount = l ? Number(l.container_count) || 0 : (g.botCount || 0);
    const runningBots = l ? Number(l.running_count) || 0 : 0;
    // "running" only counts when bots are actually up, otherwise the card
    // would show a green light for a group that is still booting.
    let state = 'unknown';
    if (l) {
      if (l.status === 'running') state = runningBots > 0 || !botCount ? 'running' : 'starting';
      else state = l.status === 'stopped' ? 'stopped' : (l.status || 'unknown');
    } else if (live.size) state = 'ended';
    else state = g.status || 'unknown';
    return {
      groupId: g.groupId, clanId: g.clanId, region: g.regionName || g.region,
      price: g.price, createdAt: g.createdAt,
      status: l ? l.status : (live.size ? 'ended' : (g.status || 'unknown')),
      state,
      uptime: l ? l.uptime : '',
      botCount,
      running: runningBots,
      clanName: l ? dig(l, ['clan_name', 'clanName', 'name']) : undefined,
      games: l ? dig(l, ['games', 'games_played', 'matches', 'match_count', 'total_games']) : undefined,
      since: l ? dig(l, ['since', 'last_match_at', 'last_match_time', 'last_match']) : undefined,
      ...(l ? pickLogo(l) : { logoUrl: '' }),
    };
  }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  res.json({ success: true, groups });
}));

// POST /api/glory/launch { region, clan_id }
router.post('/launch', rateLimit({ windowMs: 60_000, max: 6, name: 'glory-launch' }), asyncHandler(async (req, res) => {
  const regionId = String(req.body?.region || '').trim();
  const clanId = String(req.body?.clan_id || '').trim();
  if (!/^\d{5,15}$/.test(clanId)) {
    return res.status(400).json({ success: false, error: 'Enter a valid Clan ID (numbers only).' });
  }
  if (!gloryConfigured()) {
    return res.status(503).json({ success: false, error: 'FF Glory is not available right now.' });
  }
  if (launching.has(req.uid)) {
    return res.status(409).json({ success: false, error: 'A launch is already in progress.' });
  }
  launching.add(req.uid);

  try {
    let region;
    try {
      region = ((await getRegions()).regions || []).find((r) => r.id === regionId && r.enabled);
    } catch (e) { return fail(res, e); }
    if (!region) return res.status(400).json({ success: false, error: 'Invalid or disabled region.' });

    const price = nrpPriceForTier(region.tier);

    // Per-user group cap
    const existing = await db().collection(COL).where('uid', '==', req.uid).get();
    const active = existing.docs.filter((d) => d.data().status === 'running').length;
    if (active >= maxGroups()) {
      return res.status(403).json({ success: false, error: `You can run up to ${maxGroups()} groups at once. Stop or delete one first.` });
    }

    // 1) Charge NRP atomically (before calling upstream).
    const userRef = db().collection('users').doc(req.uid);
    const charged = await db().runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      const data = snap.exists ? snap.data() : {};
      const balance = Number(data.balance || 0);
      if (balance < price) return { ok: false, balance };
      tx.set(userRef, {
        balance: balance - price,
        totalSpent: admin.firestore.FieldValue.increment(price),
      }, { merge: true });
      return { ok: true, balance, newBalance: balance - price, label: data.profileName || req.email };
    });
    if (!charged.ok) {
      return res.status(402).json({
        success: false, code: 'INSUFFICIENT_BALANCE',
        error: `You need NRP ${price} to launch this group. Please top up first.`,
        balance: charged.balance, required: price,
      });
    }
    invalidateUserDoc(req.uid);

    const refund = async () => {
      await userRef.set({
        balance: admin.firestore.FieldValue.increment(price),
        totalSpent: admin.firestore.FieldValue.increment(-price),
      }, { merge: true });
      invalidateUserDoc(req.uid);
    };

    // 2) Launch upstream (one at a time across all users).
    let out;
    try {
      out = await serialized(async () => {
        const r = await gloryCall('POST', '/api/client/auto-clan-group', {
          body: { region: region.id, clan_id: clanId },
        });
        let id = pickId(r);
        if (!id && !(r && r.success === false)) {
          // Upstream said OK but we couldn't read the id — find the new group by clan.
          console.error('[glory] launch reply had no group id:', JSON.stringify(r).slice(0, 500));
          id = await findNewGroup(clanId);
        }
        if (!id) {
          const err = new GloryError('FF Glory service returned an unexpected reply.', { status: 502 });
          err.detail = JSON.stringify(r).slice(0, 300);
          throw err;
        }
        return { ...(r || {}), group_id: id };
      });
    } catch (e) {
      if (e instanceof GloryError && e.timeout) {
        // The group may have been created — do NOT auto-refund; flag for manual review.
        telegramNotify(`⚠️ <b>Glory launch TIMEOUT</b>\nUser: <code>${esc(req.uid)}</code>\nClan: ${esc(clanId)} · ${esc(region.id)}\nCharged NRP ${price} — check ffglory.pro and refund if no group exists.`);
        return res.status(504).json({ success: false, error: 'The service took too long. Your NRP was held — contact support if no group appears shortly.' });
      }
      await refund();
      telegramNotify(`❌ <b>Glory launch failed</b> (refunded)\nUser: <code>${esc(req.uid)}</code>\nClan: ${esc(clanId)} · ${esc(region.id)}\n${esc(e.message)}${e.detail ? '\nReply: <code>' + esc(e.detail) + '</code>' : ''}`);
      return fail(res, e);
    }

    // 3) Remember who owns the group.
    const record = {
      uid: req.uid, groupId: out.group_id, clanId, region: region.id, regionName: region.region_name,
      tier: region.tier, price, botCount: out.bot_count || 0, status: 'running',
      createdAt: new Date().toISOString(),
    };
    try {
      await db().collection(COL).doc(out.group_id).set(record);
    } catch (e) {
      console.error('[glory] failed to save ownership record', out.group_id, e);
      telegramNotify(`🚨 <b>Glory group launched but NOT saved</b>\nGroup: <code>${esc(out.group_id)}</code>\nUser: <code>${esc(req.uid)}</code>`);
    }

    telegramNotify(`🤖 <b>Glory launched</b>\n${esc(charged.label)}\nClan: ${esc(clanId)} · ${esc(region.id)} (${esc(region.tier)})\nNRP ${price} → balance ${charged.newBalance}`);
    res.json({ success: true, groupId: out.group_id, newBalance: charged.newBalance, group: record });
  } finally {
    launching.delete(req.uid);
  }
}));

// POST /api/glory/action { group_id, action }
const ACTIONS = new Set(['restart', 'stop', 'delete', 'get-glory', 'get-clan-info']);
router.post('/action', rateLimit({ windowMs: 60_000, max: 40, name: 'glory-action' }), asyncHandler(async (req, res) => {
  const groupId = String(req.body?.group_id || '').trim();
  const action = String(req.body?.action || '').trim();
  if (!groupId || !ACTIONS.has(action)) {
    return res.status(400).json({ success: false, error: 'Invalid request.' });
  }
  const ref = db().collection(COL).doc(groupId);
  const doc = await ref.get();
  // Ownership check — a user can only touch their own groups.
  if (!doc.exists || doc.data().uid !== req.uid || doc.data().status === 'deleted') {
    return res.status(404).json({ success: false, error: 'Group not found.' });
  }

  try {
    const run = () => gloryCall('POST', '/api/client/group-action', { body: { action, group_id: groupId } });
    const mutating = action === 'restart' || action === 'stop' || action === 'delete';
    const out = mutating ? await serialized(run) : await run();

    if (action === 'stop') await ref.set({ status: 'stopped' }, { merge: true });
    if (action === 'restart') await ref.set({ status: 'running' }, { merge: true });
    if (action === 'delete') await ref.set({ status: 'deleted', deletedAt: new Date().toISOString() }, { merge: true });

    res.json({ success: true, result: out });
  } catch (e) { return fail(res, e); }
}));

// GET /api/glory/details?group_id=X[&fresh=1] — live glory + clan info for ONE of your groups.
router.get('/details', rateLimit({ windowMs: 60_000, max: 60, name: 'glory-details' }), asyncHandler(async (req, res) => {
  if (!(await ownGroup(req, res))) return;
  try {
    const details = await loadDetails(String(req.query.group_id), req.query.fresh === '1');
    res.json({ success: true, details });
  } catch (e) { return fail(res, e); }
}));

// GET /api/glory/progress?group_id=X — glory timeline (documented endpoint).
router.get('/progress', rateLimit({ windowMs: 60_000, max: 30, name: 'glory-progress' }), asyncHandler(async (req, res) => {
  if (!(await ownGroup(req, res))) return;
  try {
    const out = await serialized(() => gloryCall('GET', '/api/client/glory-progression', {
      query: { group_id: String(req.query.group_id) }, timeoutMs: 20000,
    }));
    const snaps = Array.isArray(out?.snapshots) ? out.snapshots : [];
    res.json({
      success: true,
      clanId: out?.clan_id, gloryFarmed: out?.glory_farmed,
      snapshots: snaps.slice(-12).map((x) => ({ at: x.captured_at, glory: x.total_glory, hours: x.uptime_hours })),
    });
  } catch (e) { return fail(res, e); }
}));

export default router;
