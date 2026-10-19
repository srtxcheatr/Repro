// src by SRT X CHEATS. Copy right SRT X CHEATS
import { db } from './firebase.js';
import { normalizeUrlField, RuleError } from './profileRules.js';
import { BADGES as AVATAR_BADGES, BANNERS, PROFILES, botCosmetics } from './rewards.js';

// src by SRT X CHEATS. Copy right SRT X CHEATS
const COL = 'leaderboardBots';
export const BOT_PREFIX = 'bot_';
export const BADGES = ['', 'gold', 'silver', 'bronze'];
export const MAX_BOTS = 20;

// src by SRT X CHEATS. Copy right SRT X CHEATS
export const isBotUid = (uid) => typeof uid === 'string' && uid.startsWith(BOT_PREFIX);
export const botDocId = (uid) => String(uid).slice(BOT_PREFIX.length);

export function cleanBotInput(body, { partial = false } = {}) {
  const out = {};
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const has = (k) => !partial || body[k] !== undefined;

  if (has('name')) {
    const name = String(body.name ?? '').trim();
    if (!name) throw new RuleError('Name is required.');
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    if (name.length > 40) throw new RuleError('Name is too long (max 40 characters).');
    out.name = name;
  }
  if (has('logoUrl')) {
    const raw = String(body.logoUrl ?? '').trim();
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    if (!raw) throw new RuleError('Logo URL is required.');
    if (raw.length > 500) throw new RuleError('Logo URL is too long (max 500 characters).');
    if (!/^https:\/\//i.test(raw)) throw new RuleError('Logo URL must start with https://');
    try { new URL(raw); } catch { throw new RuleError('Logo URL is not a valid address.'); }
    out.logoUrl = raw;
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  }
  if (has('number')) {
    const number = String(body.number ?? '').trim();
    if (!number) throw new RuleError('Number is required.');
    if (!/^[0-9+\-\s()]{5,20}$/.test(number)) throw new RuleError('Number can only have digits, +, -, spaces (5–20 characters).');
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    out.number = number;
  }
  if (has('resellerLink')) {
    out.resellerLink = normalizeUrlField(body.resellerLink, 'Reseller link', { maxLen: 300 });
  }
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (has('keysBought')) {
    const n = Number(body.keysBought);
    if (!Number.isInteger(n) || n < 0 || n > 10_000_000) throw new RuleError('Bought keys must be a whole number (0 – 10,000,000).');
    out.keysBought = n;
  }
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (has('spent')) {
    const n = Number(body.spent);
    if (!Number.isFinite(n) || n < 0 || n > 1_000_000_000) throw new RuleError('Spend must be a number (0 – 1,000,000,000).');
    out.spent = Math.round(n * 100) / 100;
  }
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (has('badge')) {
    const b = String(body.badge ?? '').trim().toLowerCase();
    if (!BADGES.includes(b)) throw new RuleError('Badge must be none, gold, silver or bronze.');
    out.badge = b;
  }
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (has('avatarBadge')) {
    const v = String(body.avatarBadge ?? '').trim();
    if (v && !AVATAR_BADGES.includes(v)) throw new RuleError('Unknown avatar badge.');
    out.avatarBadge = v;
  }
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (has('bannerEffect')) {
    const v = String(body.bannerEffect ?? '').trim();
    if (v && !BANNERS.includes(v)) throw new RuleError('Unknown banner effect.');
    out.bannerEffect = v;
  }
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (has('profileEffect')) {
    const v = String(body.profileEffect ?? '').trim();
    if (v && !PROFILES.includes(v)) throw new RuleError('Unknown profile effect.');
    out.profileEffect = v;
  }
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  return out;
}

export async function listBots() {
  const snap = await db().collection(COL).orderBy('createdAt', 'desc').limit(MAX_BOTS + 5).get();
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function getBot(id) {
  const snap = await db().collection(COL).doc(String(id)).get();
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

export async function createBot(body) {
  const data = cleanBotInput(body);
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const existing = await db().collection(COL).count().get().then((a) => a.data().count).catch(() => 0);
  if (existing >= MAX_BOTS) throw new RuleError(`You can have at most ${MAX_BOTS} promo entries. Delete one first.`);
  const ref = db().collection(COL).doc();
  const doc = { ...data, createdAt: Date.now(), updatedAt: Date.now() };
  await ref.set(doc);
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  return { id: ref.id, ...doc };
}

export async function updateBot(id, body) {
  const ref = db().collection(COL).doc(String(id));
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const snap = await ref.get();
  if (!snap.exists) throw new RuleError('Promo entry not found.', 404);
  const data = cleanBotInput(body, { partial: true });
  await ref.set({ ...data, updatedAt: Date.now() }, { merge: true });
  return { id: ref.id, ...snap.data(), ...data };
// src by SRT X CHEATS. Copy right SRT X CHEATS
}

export async function deleteBot(id) {
  const ref = db().collection(COL).doc(String(id));
  const snap = await ref.get();
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (!snap.exists) throw new RuleError('Promo entry not found.', 404);
  await ref.delete();
}

export function botToBoardRow(b) {
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  return {
    uid: BOT_PREFIX + b.id,
    name: b.name,
    avatarUrl: b.logoUrl,
    totalKeysBought: Number(b.keysBought || 0),
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    totalSpent: Number(b.spent || 0),
    badge: b.badge || '',
    cosmetics: botCosmetics(b),
  };
}
// src by SRT X CHEATS. Copy right SRT X CHEATS
