// src/rewards.js — REWARD CENTER: missions, cashback, unlockable badges / banner
// effects / profile effects, and what the user has equipped.
//
// Progress = users/{uid}.totalKeysBought (the same number the leaderboard ranks
// by; the store AND the reseller API both increment it).
//
// WHERE THINGS ARE STORED
//   userRewards/{uid} = { claimed: { m10: ms, ... }, equipped: { badge, banner, profile }, updatedAt }
//   It is a SERVER-ONLY collection (no Firestore rule opens it to browsers), so a
//   user can never write "I claimed it" / "I unlocked it" from dev tools.
//
// WHAT IS UNLOCKED = missions the user has CLAIMED. Equipped items are re-checked
// against that every time they are saved AND every time they are shown to other
// people, so a bad/forged value can never be displayed.
import admin from 'firebase-admin';
import { db } from './firebase.js';
import { RuleError } from './profileRules.js';
import { activeBan } from './ban.js';

const COL = 'userRewards';

// ---- STAR cashback (change the amount / date here, or via env) --------------
// STAR CASHBACK: a claim that opens on STAR_CASHBACK_FROM. Only keys bought AFTER that
// moment are counted (users/{uid}.starCb.keys starts from 0 then) — old purchases never count.
// Every STAR_CB_EVERY new keys = one claim of STAR_CB_AMOUNT (NRP). Needs the STAR mission (500 keys).
export const STAR_CB_EVERY = Number(process.env.STAR_CB_EVERY) > 0 ? Number(process.env.STAR_CB_EVERY) : 10;
export const STAR_CB_AMOUNT = Number(process.env.STAR_CB_AMOUNT) > 0 ? Number(process.env.STAR_CB_AMOUNT) : 300;
export const STAR_CASHBACK_FROM = Date.parse(process.env.STAR_CASHBACK_FROM || '2026-10-20T00:00:00+05:45');

// ---- the missions (edit here to change thresholds / rewards) ---------------
export const MISSIONS = [
  // --- unlock badges / effects (counted on ALL keys bought, claimable now; no money) ---
  { id: 'm30',  keys: 30,  title: 'Sell 30 Keys',  badge: 'silver_crown' },
  { id: 'm45',  keys: 45,  title: 'Sell 45 Keys',  badge: 'gold_crown' },
  { id: 'm70',  keys: 70,  title: 'Sell 70 Keys',  badge: 'diamond', banner: 'gold_flow', profile: 'gold_aura' },
  { id: 'm100', keys: 100, title: 'Sell 100 Keys', badge: 'T', banner: 'dark_flow', profile: 'dark_aura' },
  { id: 'm250', keys: 250, title: 'Sell 250 Keys', badge: 'R', banner: 'comet', profile: 'comet_aura' },
  // ★ STAR tier — 500 keys: badge / banner / profile effect open TODAY.
  { id: 'm500', keys: 500, title: 'Sell 500 Keys — STAR', badge: 'S', banner: 'star_royal', profile: 'star_aura' },

  // --- CASHBACK missions (cb: true) ---------------------------------------------
  // STOPPED until STAR_CASHBACK_FROM (20 Oct 2026, 00:00 Nepal). They count ONLY keys
  // bought AFTER that moment (users/{uid}.starCb.keys) — old purchases never count.
  { id: 'c10',  keys: 10,  title: 'Buy 10 New Keys',  cashback: 100, cb: true },
  { id: 'c20',  keys: 20,  title: 'Buy 20 New Keys',  cashback: 100, cb: true },
  { id: 'c100', keys: 100, title: 'Buy 100 New Keys', cashback: 300, cb: true },
  { id: 'c250', keys: 250, title: 'Buy 250 New Keys', cashback: 1000, cb: true },
];

// The ids the website knows how to draw (assets/js/rewards-ui.js + rewards.css).
export const BADGES = ['silver_crown', 'gold_crown', 'diamond', 'T', 'R', 'S'];
export const BANNERS = ['gold_flow', 'dark_flow', 'comet', 'star_royal'];
export const PROFILES = ['gold_aura', 'dark_aura', 'comet_aura', 'star_aura'];

const missionById = (id) => MISSIONS.find((m) => m.id === id) || null;
const rewardsRef = (uid) => db().collection(COL).doc(uid);
const round2 = (n) => Math.round(n * 100) / 100;

/** What a set of claimed missions unlocks. */
export function unlockedFrom(claimed) {
  const out = { badges: [], banners: [], profiles: [] };
  for (const m of MISSIONS) {
    if (!claimed || !claimed[m.id]) continue;
    if (m.badge) out.badges.push(m.badge);
    if (m.banner) out.banners.push(m.banner);
    if (m.profile) out.profiles.push(m.profile);
  }
  return out;
}

/** Keep only equipped items that the user has really unlocked. */
export function cleanEquipped(equipped, claimed) {
  const u = unlockedFrom(claimed);
  const e = equipped || {};
  return {
    badge: u.badges.includes(e.badge) ? e.badge : '',
    banner: u.banners.includes(e.banner) ? e.banner : '',
    profile: u.profiles.includes(e.profile) ? e.profile : '',
  };
}

/** Admin-made leaderboard bots can wear anything — only the ids are validated. */
export function botCosmetics(b) {
  return {
    badge: BADGES.includes(b.avatarBadge) ? b.avatarBadge : '',
    banner: BANNERS.includes(b.bannerEffect) ? b.bannerEffect : '',
    profile: PROFILES.includes(b.profileEffect) ? b.profileEffect : '',
  };
}

/** Full state for the Reward Center page. */
export async function getRewardState(uid, totalKeysBought, userData = {}) {
  const snap = await rewardsRef(uid).get();
  const r = snap.exists ? snap.data() : {};
  const u = userData || {};
  const claimed = r.claimed || {};
  const total = Number(totalKeysBought || 0);
  return {
    totalKeysBought: total,
    missions: MISSIONS.map((m) => {
      const open = !m.cb || Date.now() >= STAR_CASHBACK_FROM;
      const have = m.cb ? (open ? Number(u.starCb?.keys || 0) : 0) : total;   // cashback missions: NEW keys only
      return {
        id: m.id, keys: m.keys, title: m.title, cb: !!m.cb, have, locked: !open, opensAt: m.cb ? STAR_CASHBACK_FROM : 0,
        cashback: m.cashback || 0, badge: m.badge || '', banner: m.banner || '', profile: m.profile || '',
        claimed: !!claimed[m.id], claimedAt: claimed[m.id] || null, ready: open && have >= m.keys,
      };
    }),
    star: {
      member: !!claimed.m500, from: STAR_CASHBACK_FROM, active: Date.now() >= STAR_CASHBACK_FROM,
      every: STAR_CB_EVERY, amount: STAR_CB_AMOUNT,
      newKeys: Number(u.starCb?.keys || 0), claimedCount: Number(r.starClaimed || 0), earned: Number(r.starEarned || 0),
      available: Date.now() >= STAR_CASHBACK_FROM && claimed.m500 ? Math.max(0, Math.floor(Number(u.starCb?.keys || 0) / STAR_CB_EVERY) - Number(r.starClaimed || 0)) : 0,
    },
    unlocked: unlockedFrom(claimed),
    equipped: cleanEquipped(r.equipped, claimed),
  };
}

/**
 * Claim one mission. One transaction reads the user + rewards docs, checks the
 * key count and "not claimed yet", then credits the cashback AND marks the
 * mission claimed together — two taps / two tabs can never pay twice.
 */
export async function claimMission(uid, missionId) {
  const m = missionById(String(missionId || ''));
  if (!m) throw new RuleError('Unknown mission.', 404);

  const userRef = db().collection('users').doc(uid);
  const rRef = rewardsRef(uid);

  return db().runTransaction(async (tx) => {
    const [uSnap, rSnap] = await Promise.all([tx.get(userRef), tx.get(rRef)]);
    const u = uSnap.exists ? uSnap.data() : {};
    const r = rSnap.exists ? rSnap.data() : {};

    if (activeBan(u)) throw new RuleError('Your account is banned.', 403);
    const claimed = { ...(r.claimed || {}) };
    if (claimed[m.id]) throw new RuleError('You already claimed this reward.', 409);
    if (m.cb && Date.now() < STAR_CASHBACK_FROM) {
      throw new RuleError('Cashback opens on 20 October 2026, 12:00 AM.', 403, { code: 'NOT_OPEN_YET', startsAt: STAR_CASHBACK_FROM });
    }
    const total = m.cb ? Number(u.starCb?.keys || 0) : Number(u.totalKeysBought || 0);   // cashback = new keys only
    if (total < m.keys) throw new RuleError(`Not unlocked yet — you have ${total} of ${m.keys} keys.`, 400);

    claimed[m.id] = Date.now();
    // Newly unlocked items are worn straight away; the user can change them any time.
    const equipped = { ...cleanEquipped(r.equipped, r.claimed) };
    if (m.badge) equipped.badge = m.badge;
    if (m.banner) equipped.banner = m.banner;
    if (m.profile) equipped.profile = m.profile;

    let newBalance = Number(u.balance || 0);
    if (m.cashback) {
      newBalance = round2(newBalance + m.cashback);
      const log = Array.isArray(u.adminLog) ? [...u.adminLog] : [];
      log.push({ delta: m.cashback, note: `Reward Center cashback — ${m.title}`, resultingBalance: newBalance, at: new Date().toISOString() });
      tx.set(userRef, { balance: newBalance, adminLog: log }, { merge: true });
    }
    tx.set(rRef, { claimed, equipped, updatedAt: Date.now() }, { merge: true });

    return { mission: m, newBalance, cashback: m.cashback || 0, equipped, unlocked: unlockedFrom(claimed), user: u };
  });
}

/** Save what the user chose to wear. '' = nothing. Anything not unlocked is refused. */
export async function setEquipped(uid, body) {
  const snap = await rewardsRef(uid).get();
  const r = snap.exists ? snap.data() : {};
  const claimed = r.claimed || {};
  const u = unlockedFrom(claimed);
  const next = { ...cleanEquipped(r.equipped, claimed) };

  const pick = (field, list, unlocked, label) => {
    if (body[field] === undefined) return;
    const v = String(body[field] ?? '').trim();
    if (v === '') { next[field] = ''; return; }
    if (!list.includes(v) || !unlocked.includes(v)) throw new RuleError(`That ${label} is not unlocked yet.`, 403);
    next[field] = v;
  };
  pick('badge', BADGES, u.badges, 'badge');
  pick('banner', BANNERS, u.banners, 'banner effect');
  pick('profile', PROFILES, u.profiles, 'profile effect');

  await rewardsRef(uid).set({ equipped: next, updatedAt: Date.now() }, { merge: true });
  return next;
}

/** What other people see for these users. Map<uid, {badge, banner, profile}>. One batched read. */
export async function cosmeticsFor(uids) {
  const out = new Map();
  const list = [...new Set(uids)].filter(Boolean);
  if (!list.length) return out;
  const snaps = await db().getAll(...list.map(rewardsRef));
  snaps.forEach((s, i) => {
    const r = s.exists ? s.data() : null;
    if (r) out.set(list[i], cleanEquipped(r.equipped, r.claimed));
  });
  return out;
}
export const NO_COSMETICS = Object.freeze({ badge: '', banner: '', profile: '' });

// ---- STAR cashback: count NEW keys only -------------------------------------
/** Fields to merge into the user doc when keys are bought. Empty before STAR_CASHBACK_FROM, so old buys never count. */
export function newKeyFields(keys, now = Date.now()) {
  if (now < STAR_CASHBACK_FROM || !(keys > 0)) return {};
  return { starCb: { keys: admin.firestore.FieldValue.increment(keys) } };
}

/** Claim every finished batch of new keys. Locked until STAR_CASHBACK_FROM. One transaction = no double pay. */
export async function claimStarCashback(uid) {
  if (Date.now() < STAR_CASHBACK_FROM) {
    const d = new Date(STAR_CASHBACK_FROM).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kathmandu' });
    throw new RuleError(`STAR cashback opens on ${d}, 12:00 AM.`, 403, { code: 'NOT_OPEN_YET', startsAt: STAR_CASHBACK_FROM });
  }
  const userRef = db().collection('users').doc(uid);
  const rRef = rewardsRef(uid);
  return db().runTransaction(async (tx) => {
    const [uSnap, rSnap] = await Promise.all([tx.get(userRef), tx.get(rRef)]);
    const u = uSnap.exists ? uSnap.data() : {};
    const r = rSnap.exists ? rSnap.data() : {};
    if (activeBan(u)) throw new RuleError('Your account is banned.', 403);
    if (!(r.claimed && r.claimed.m500)) throw new RuleError('Claim the STAR mission (500 keys) first.', 403);
    const newKeys = Number(u.starCb?.keys || 0);
    const done = Number(r.starClaimed || 0);
    const batches = Math.floor(newKeys / STAR_CB_EVERY) - done;
    if (batches < 1) throw new RuleError(`Buy ${STAR_CB_EVERY - (newKeys % STAR_CB_EVERY)} more new key(s) to unlock the next cashback.`, 400);
    const cash = round2(batches * STAR_CB_AMOUNT);
    const newBalance = round2(Number(u.balance || 0) + cash);
    const log = Array.isArray(u.adminLog) ? [...u.adminLog] : [];
    log.push({ delta: cash, note: `STAR cashback — ${batches} x ${STAR_CB_EVERY} new keys`, resultingBalance: newBalance, at: new Date().toISOString() });
    tx.set(userRef, { balance: newBalance, adminLog: log }, { merge: true });
    tx.set(rRef, { starClaimed: done + batches, starEarned: round2(Number(r.starEarned || 0) + cash), updatedAt: Date.now() }, { merge: true });
    return { cash, batches, newBalance, user: u };
  });
}
