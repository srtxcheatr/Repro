// src by SRT X CHEATS. Copy right SRT X CHEATS
import { bump } from './versions.js';

const num = (name, fallback) => {
  const v = Number(process.env[name]);
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

const MIN = 60 * 1000;

// src by SRT X CHEATS. Copy right SRT X CHEATS
export const TTL = {
  catalog: num('CATALOG_CACHE_TTL_MS', 6 * 60 * MIN),
  feedback: num('FEEDBACK_CACHE_TTL_MS', 6 * 60 * MIN),
  leaderboard: num('LEADERBOARD_CACHE_TTL_MS', 10 * MIN),
  announcement: num('ANNOUNCEMENT_CACHE_TTL_MS', 6 * 60 * MIN),
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  policy: num('POLICY_CACHE_TTL_MS', 6 * 60 * MIN),
  userDoc: num('USER_DOC_CACHE_TTL_MS', 5 * MIN),
};

export function cachedLoader(load, { ttlMs, name = 'cache', versionKey = null }) {
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  let value;
  let at = 0;
  let inflight = null;
  let generation = 0;

  // src by SRT X CHEATS. Copy right SRT X CHEATS
  async function get() {
    if (at && Date.now() - at < ttlMs) return value;
    if (inflight) return inflight;

    const startedIn = generation;
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    inflight = (async () => {
      try {
        const v = await load();
        if (startedIn === generation) { value = v; at = Date.now(); }
        return v;
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      } catch (e) {
        if (at) {
          console.error(`[cache:${name}] refresh failed, serving stale copy:`, e?.message || e);
          return value;
        }
        // src by SRT X CHEATS. Copy right SRT X CHEATS
        throw e;
      } finally {
        inflight = null;
      }
    })();
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    return inflight;
  }

  return {
    get,
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    invalidate() { generation++; at = 0; inflight = null; if (versionKey) bump(versionKey); },
    patch(fn) { if (at) value = fn(value); if (versionKey) bump(versionKey); },
    set(v) { value = v; at = Date.now(); if (versionKey) bump(versionKey); },
    peek() { return at ? value : undefined; },
  };
// src by SRT X CHEATS. Copy right SRT X CHEATS
}

export function cachedKeyedLoader(load, { ttlMs, name = 'keyed-cache', maxEntries = 5000 }) {
  const entries = new Map();
  const inflight = new Map();
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const generation = new Map();

  async function get(key) {
    const hit = entries.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    if (inflight.has(key)) return inflight.get(key);

    const startedIn = generation.get(key) || 0;
    const p = (async () => {
      try {
        // src by SRT X CHEATS. Copy right SRT X CHEATS
        const v = await load(key);
        if ((generation.get(key) || 0) === startedIn) {
          if (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
          entries.set(key, { value: v, at: Date.now() });
        }
        // src by SRT X CHEATS. Copy right SRT X CHEATS
        return v;
      } catch (e) {
        if (hit) {
          console.error(`[cache:${name}] refresh failed for ${key}, serving stale copy:`, e?.message || e);
          return hit.value;
        // src by SRT X CHEATS. Copy right SRT X CHEATS
        }
        throw e;
      } finally {
        inflight.delete(key);
      }
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    })();
    inflight.set(key, p);
    return p;
  }

  // src by SRT X CHEATS. Copy right SRT X CHEATS
  return {
    get,
    invalidate(key) {
      generation.set(key, (generation.get(key) || 0) + 1);
      entries.delete(key);
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      inflight.delete(key);
    },
    invalidateAll() { entries.clear(); inflight.clear(); generation.clear(); },
  };
}
// src by SRT X CHEATS. Copy right SRT X CHEATS
