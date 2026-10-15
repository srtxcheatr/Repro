// src/glory.js — server-side client for the ffglory.pro reseller API.
// The API key + master key come ONLY from environment variables and are
// never sent to the browser.

const BASE = () => String(process.env.GLORY_BASE_URL || 'https://ffglory.pro').replace(/\/+$/, '');

export class GloryError extends Error {
  constructor(message, { status = 502, timeout = false, upstream = '', detail = '', unreadable = false, rawText = '' } = {}) {
    super(message);
    this.unreadable = unreadable; // HTTP 200 but the body was not JSON (the action may still have happened upstream)
    this.rawText = rawText;
    this.detail = detail; // short diagnostic (status / content-type / first bytes of the reply)
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

  // Browser-like headers: some CDNs/WAFs answer a bare Node request with an HTML
  // page (HTTP 200) instead of JSON, which showed up as "unreadable reply".
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': process.env.GLORY_USER_AGENT
      || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Origin: BASE(),
    Referer: BASE() + '/',
  };
  if (auth) headers['x-api-key'] = process.env.GLORY_MASTER_KEY;
  if (body) headers['Content-Type'] = 'application/json';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let r, text, finalUrl = url;
  try {
    // Follow redirects ourselves so a POST stays a POST (fetch turns a 301/302
    // POST into a GET, which returns an HTML page instead of JSON).
    for (let hop = 0; ; hop++) {
      r = await fetch(finalUrl, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal, redirect: 'manual' });
      if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.get('location') && hop < 4) {
        finalUrl = new URL(r.headers.get('location'), finalUrl);
        // keep the secret only on the same host
        if (finalUrl.host !== url.host) { delete headers['x-api-key']; finalUrl.searchParams.delete('api_key'); }
        await r.arrayBuffer().catch(() => {});
        continue;
      }
      break;
    }
    text = await r.text();
  } catch (e) {
    if (e?.name === 'AbortError') throw new GloryError('FF Glory service timed out.', { status: 504, timeout: true });
    console.error('[glory] network error', method, path, e?.cause?.code || e?.message);
    throw new GloryError('Could not reach the FF Glory service.', { status: 502, detail: String(e?.cause?.code || e?.message || '') });
  } finally {
    clearTimeout(timer);
  }

  // Lenient JSON: strip a BOM / junk and, if the body is text around a JSON
  // object or array, pull that out.
  let data = null;
  const clean = String(text || '').replace(/^\uFEFF/, '').trim();
  const tryJson = (t) => { try { return JSON.parse(t); } catch (_) { return undefined; } };
  data = clean ? tryJson(clean) : null;
  if (data === undefined) {
    // Several JSON lines (progress + result), "data: {...}" event-stream lines,
    // or JSON wrapped in other text: take the best JSON object found.
    const found = [];
    for (const line of clean.split(/\r?\n/)) {
      const t = line.replace(/^\s*data:\s*/i, '').trim();
      if (!t) continue;
      const v = tryJson(t);
      if (v !== undefined && v !== null && typeof v === 'object') found.push(v);
    }
    if (!found.length) {
      const m = clean.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      if (m) { const v = tryJson(m[0]); if (v !== undefined) found.push(v); }
    }
    const withId = [...found].reverse().find((o) => o && (o.group_id || o.groupId || o.success !== undefined));
    data = withId || found[found.length - 1] || null;
  }
  const ctype = r.headers.get('content-type') || '';
  const upstreamMsg = data && typeof data === 'object' ? String(data.error || data.message || '') : '';
  const diag = `HTTP ${r.status} ${ctype.split(';')[0]} ${finalUrl.host}${finalUrl.pathname} :: ${clean.slice(0, 160).replace(/\s+/g, ' ')}`;

  if (!r.ok) {
    console.error('[glory] upstream', method, path, diag);
    throw new GloryError(friendly(r.status, upstreamMsg), { status: r.status, upstream: upstreamMsg, detail: diag });
  }
  if (data === null) {
    // 200 but not JSON -> an error/challenge page. Never hand `null` to callers.
    console.error('[glory] upstream non-JSON reply', method, path, diag);
    throw new GloryError('FF Glory service returned an unreadable reply. Please try again.', { status: 502, detail: diag, unreadable: true, rawText: clean.slice(0, 2000) });
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

// ---- Safe self-test (GET only — never launches anything, never spends credits) ----
const redact = (t) => {
  let out = String(t);
  for (const k of [process.env.GLORY_API_KEY, process.env.GLORY_MASTER_KEY]) if (k) out = out.split(k).join('***');
  return out;
};
export async function diagnoseGlory() {
  const lines = [];
  for (const [path, auth] of [['/api/pricing', false], ['/api/auth/me', true], ['/api/client/my-groups', true]]) {
    try {
      const r = await gloryCall('GET', path, { auth, timeoutMs: 15000 });
      const n = Array.isArray(r) ? ` (${r.length} items)` : '';
      lines.push(`${path} OK${n} ${redact(JSON.stringify(r)).slice(0, 200)}`);
    } catch (e) {
      lines.push(`${path} FAIL ${e.message} | ${redact(e.detail || '')}`);
    }
  }
  return lines;
}
