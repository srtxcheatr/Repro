// src/glory.js — server-side client for the ffglory.pro reseller API.
// The API key + master key come ONLY from environment variables and are
// never sent to the browser.

const BASE = () => String(process.env.GLORY_BASE_URL || 'https://ffglory.pro').replace(/\/+$/, '');

export class GloryError extends Error {
  constructor(message, { status = 502, timeout = false, upstream = '' } = {}) {
    super(message);
    this.status = status;
    this.timeout = timeout;
    this.upstream = upstream; // the upstream's own error text, untouched (used by refunds)
  }
}

export function gloryConfigured() {
  return !!(process.env.GLORY_API_KEY && process.env.GLORY_MASTER_KEY);
}

// The reseller account is ONE account shared by all your users, and the
// upstream answers 409 if two operations hit it at once — so every call
// that changes something runs one at a time through this queue.
let chain = Promise.resolve();
export function serialized(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

function friendly(status, upstreamMsg) {
  if (status === 402) return 'FF Glory service is temporarily out of capacity. Please try again later.';
  if (status === 403) return upstreamMsg || 'Limit reached for this clan or service.';
  if (status === 404) return 'Group not found.';
  if (status === 409) return 'Another operation is in progress. Please wait a few seconds and try again.';
  if (status === 429) return 'Too many requests. Please wait a moment.';
  if (status === 400) return upstreamMsg || 'Invalid request.';
  return 'FF Glory service error. Please try again.';
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// One HTTP attempt. Throws GloryError on network failure / timeout / bad reply.
async function gloryOnce(method, path, { body, query, auth, timeoutMs }) {
  const url = new URL(BASE() + path);
  if (auth) url.searchParams.set('api_key', process.env.GLORY_API_KEY);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);

  const headers = { Accept: 'application/json' };
  if (auth) headers['x-api-key'] = process.env.GLORY_MASTER_KEY;
  if (body) headers['Content-Type'] = 'application/json';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let r, text;
  try {
    r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
    text = await r.text();
  } catch (e) {
    if (e?.name === 'AbortError') throw new GloryError('FF Glory service timed out.', { status: 504, timeout: true });
    throw new GloryError('Could not reach the FF Glory service.', { status: 502 });
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON body (HTML error page, Cloudflare...) */ }
  const upstreamMsg = data && typeof data === 'object' ? String(data.error || data.message || '') : '';

  if (!r.ok) {
    console.error('[glory] upstream', method, path, r.status, upstreamMsg || text.slice(0, 120));
    throw new GloryError(friendly(r.status, upstreamMsg), { status: r.status, upstream: upstreamMsg });
  }
  if (data === null) {
    // 200 but not JSON -> an error/challenge page. Never hand `null` to callers.
    console.error('[glory] upstream non-JSON reply', method, path, text.slice(0, 120));
    throw new GloryError('FF Glory service returned an unreadable reply. Please try again.', { status: 502 });
  }
  return data;
}

// GET requests are safe to repeat, so a network blip / 502 / 503 / 504 gets up to
// 2 more tries. Anything that changes something (POST) is tried exactly once.
export async function gloryCall(method, path, { body, query, auth = true, timeoutMs = 25000 } = {}) {
  if (auth && !gloryConfigured()) {
    throw new GloryError('FF Glory is not configured on the server.', { status: 503 });
  }
  const maxTries = method === 'GET' ? 3 : 1;
  for (let i = 1; ; i++) {
    try {
      return await gloryOnce(method, path, { body, query, auth, timeoutMs });
    } catch (e) {
      const transient = e instanceof GloryError && !e.timeout && [502, 503, 504].includes(e.status);
      if (i < maxTries && transient) { await sleepMs(600 * i); continue; }
      throw e;
    }
  }
}

// ---- Region list (public endpoint), cached 10 minutes ----
let pricingCache = { at: 0, data: null };
export async function getRegions() {
  if (pricingCache.data && Date.now() - pricingCache.at < 10 * 60 * 1000) return pricingCache.data;
  try {
    const data = await gloryCall('GET', '/api/pricing', { auth: false, timeoutMs: 10000 });
    pricingCache = { at: Date.now(), data };
    return data;
  } catch (e) {
    if (pricingCache.data) return pricingCache.data; // stale on error
    throw e;
  }
}

// Only the Basic tier is sold. Premium regions from the upstream are ignored.
export const isBasicRegion = (r) => !!r && r.enabled && String(r.tier || '').toLowerCase() !== 'premium';

// Two prices, both set in .env (NRP per group):
//   GLORY_PRICE_USER_NRP      — normal users            (falls back to GLORY_PRICE_BASIC_NRP, then 250)
//   GLORY_PRICE_RESELLER_NRP  — accounts with role 'reseller' (falls back to the user price)
const num = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && String(v ?? '').trim() !== '' ? n : null; };
export function nrpPriceForRole(role) {
  const user = num(process.env.GLORY_PRICE_USER_NRP) ?? num(process.env.GLORY_PRICE_BASIC_NRP) ?? 250;
  if (role === 'reseller') return num(process.env.GLORY_PRICE_RESELLER_NRP) ?? user;
  return user;
}
