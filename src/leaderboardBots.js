// src/leaderboardBots.js — admin-made "promo" entries for the Top-10 leaderboard.
//
// Stored in Firestore collection `leaderboardBots`. They are NOT real user
// accounts: no login, no balance, no purchases. They only exist so the admin
// can fill / promote the leaderboard (a reseller shop-window, a new store...).
//
//   name          shown on the board                     (required)
//   logoUrl       avatar image, https://...              (required)
//   number        WhatsApp / contact number              (required)
//   resellerLink  optional panel link shown on the card
//   keysBought    "Bought key"  — fully customizable
//   spent         "Spend"       — fully customizable (NRP)
//   badge         '' | 'gold' | 'silver' | 'bronze'  (crown badge)
//   avatarBadge   '' | silver_crown | gold_crown | diamond | T | R | S      (Reward Center badge)
//   bannerEffect  '' | gold_flow | dark_flow | comet | star_royal                    (leaderboard banner effect)
//   profileEffect '' | gold_aura | dark_aura | comet_aura | star_aura               (profile view effect)
//
// Their board id is  "bot_<docId>"  so the website's "View" button and
// /api/user/public-profile can tell them apart from real Firebase uids.
import { db } from './firebase.js';
import { normalizeUrlField, RuleError } from './profileRules.js';
import { BADGES as AVATAR_BADGES, BANNERS, PROFILES, botCosmetics } from './rewards.js';

const COL = 'leaderboardBots';
export const BOT_PREFIX = 'bot_';
export const BADGES = ['', 'gold', 'silver', 'bronze'];
export const MAX_BOTS = 20;

export const isBotUid = (uid) => typeof uid === 'string' && uid.startsWith(BOT_PREFIX);
export const botDocId = (uid) => String(uid).slice(BOT_PREFIX.length);

/** Validate + clean the admin's input. Throws RuleError (400) on bad input. */
export function cleanBotInput(body, { partial = false } = {}) {
  const out = {};
  const has = (k) => !partial || body[k] !== undefined;

  if (has('name')) {
    const name = String(body.name ?? '').trim();
    if (!name) throw new RuleError('Name is required.');
    if (name.length > 40) throw new RuleError('Name is too long (max 40 characters).');
    out.name = name;
  }
  if (has('logoUrl')) {
    const raw = String(body.logoUrl ?? '').trim();
    if (!raw) throw new RuleError('Logo URL is required.');
    if (raw.length > 500) throw new RuleError('Logo URL is too long (max 500 characters).');
    if (!/^https:\/\//i.test(raw)) throw new RuleError('Logo URL must start with https://');
    try { new URL(raw); } catch { throw new RuleError('Logo URL is not a valid address.'); }
    out.logoUrl = raw;
  }
  if (has('number')) {
    const number = String(body.number ?? '').trim();
    if (!number) throw new RuleError('Number is required.');
    if (!/^[0-9+\-\s()]{5,20}$/.test(number)) throw new RuleError('Number can only have digits, +, -, spaces (5–20 characters).');
    out.number = number;
  }
  if (has('resellerLink')) {
    // optional — '' clears it
    out.resellerLink = normalizeUrlField(body.resellerLink, 'Reseller link', { maxLen: 300 });
  }
  if (has('keysBought')) {
    const n = Number(body.keysBought);
    if (!Number.isInteger(n) || n < 0 || n > 10_000_000) throw new RuleError('Bought keys must be a whole number (0 – 10,000,000).');
    out.keysBought = n;
  }
  if (has('spent')) {
    const n = Number(body.spent);
    if (!Number.isFinite(n) || n < 0 || n > 1_000_000_000) throw new RuleError('Spend must be a number (0 – 1,000,000,000).');
    out.spent = Math.round(n * 100) / 100;
  }
  if (has('badge')) {
    const b = String(body.badge ?? '').trim().toLowerCase();
    if (!BADGES.includes(b)) throw new RuleError('Badge must be none, gold, silver or bronze.');
    out.badge = b;
  }
  // Reward Center cosmetics — the admin can give a promo entry any of them.
  if (has('avatarBadge')) {
    const v = String(body.avatarBadge ?? '').trim();
    if (v && !AVATAR_BADGES.includes(v)) throw new RuleError('Unknown avatar badge.');
    out.avatarBadge = v;
  }
  if (has('bannerEffect')) {
    const v = String(body.bannerEffect ?? '').trim();
    if (v && !BANNERS.includes(v)) throw new RuleError('Unknown banner effect.');
    out.bannerEffect = v;
  }
  if (has('profileEffect')) {
    const v = String(body.profileEffect ?? '').trim();
    if (v && !PROFILES.includes(v)) throw new RuleError('Unknown profile effect.');
    out.profileEffect = v;
  }
  return out;
}

export async function listBots() {
  const snap = await db().collection(COL).orderBy('createdAt', 'desc').limit(MAX_BOTS + 5).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function getBot(id) {
  const snap = await db().collection(COL).doc(String(id)).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

export async function createBot(body) {
  const data = cleanBotInput(body);
  const existing = await db().collection(COL).count().get().then((a) => a.data().count).catch(() => 0);
  if (existing >= MAX_BOTS) throw new RuleError(`You can have at most ${MAX_BOTS} promo entries. Delete one first.`);
  const ref = db().collection(COL).doc();
  const doc = { ...data, createdAt: Date.now(), updatedAt: Date.now() };
  await ref.set(doc);
  return { id: ref.id, ...doc };
}

export async function updateBot(id, body) {
  const ref = db().collection(COL).doc(String(id));
  const snap = await ref.get();
  if (!snap.exists) throw new RuleError('Promo entry not found.', 404);
  const data = cleanBotInput(body, { partial: true });
  await ref.set({ ...data, updatedAt: Date.now() }, { merge: true });
  return { id: ref.id, ...snap.data(), ...data };
}

export async function deleteBot(id) {
  const ref = db().collection(COL).doc(String(id));
  const snap = await ref.get();
  if (!snap.exists) throw new RuleError('Promo entry not found.', 404);
  await ref.delete();
}

/** Row shape used by the public leaderboard (same fields as real users + badge). */
export function botToBoardRow(b) {
  return {
    uid: BOT_PREFIX + b.id,
    name: b.name,
    avatarUrl: b.logoUrl,
    totalKeysBought: Number(b.keysBought || 0),
    totalSpent: Number(b.spent || 0),
    badge: b.badge || '',
    cosmetics: botCosmetics(b),
  };
}
