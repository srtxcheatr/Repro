// src by SRT X CHEATS. Copy right SRT X CHEATS
const BASE = () => String(process.env.GLORY_BASE_URL || 'https://ffglory.pro').replace(/\/+$/, '');

export class GloryError extends Error {
  constructor(message, { status = 502, timeout = false, upstream = '', detail = '', unreadable = false, rawText = '' } = {}) {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    super(message);
    this.unreadable = unreadable;
    this.rawText = rawText;
    this.detail = detail;
    this.status = status;
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    this.timeout = timeout;
    this.upstream = upstream;
  }
}

// src by SRT X CHEATS. Copy right SRT X CHEATS
export function gloryConfigured() {
  return !!(process.env.GLORY_API_KEY && process.env.GLORY_MASTER_KEY);
}

let chain = Promise.resolve();
// src by SRT X CHEATS. Copy right SRT X CHEATS
export function serialized(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}
// src by SRT X CHEATS. Copy right SRT X CHEATS

function friendly(status, upstreamMsg) {
  if (status === 402) return 'FF Glory service is temporarily out of capacity. Please try again later.';
  if (status === 403) return upstreamMsg || 'Limit reached for this clan or service.';
  if (status === 404) return 'Group not found.';
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (status === 409) return 'Another operation is in progress. Please wait a few seconds and try again.';
  if (status === 429) return 'Too many requests. Please wait a moment.';
  if (status === 400) return upstreamMsg || 'Invalid request.';
  return 'FF Glory service error. Please try again.';
}
// src by SRT X CHEATS. Copy right SRT X CHEATS

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

async function gloryOnce(method, path, { body, query, auth, timeoutMs }) {
  const url = new URL(BASE() + path);
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (auth) url.searchParams.set('api_key', process.env.GLORY_API_KEY);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);

  const headers = {
    Accept: 'application/json, text/plain, */*',
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': process.env.GLORY_USER_AGENT
      || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Origin: BASE(),
    Referer: BASE() + '/',
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  };
  if (auth) headers['x-api-key'] = process.env.GLORY_MASTER_KEY;
  if (body) headers['Content-Type'] = 'application/json';

  const ctrl = new AbortController();
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let r, text, finalUrl = url;
  try {
    for (let hop = 0; ; hop++) {
      r = await fetch(finalUrl, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal, redirect: 'manual' });
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.get('location') && hop < 4) {
        finalUrl = new URL(r.headers.get('location'), finalUrl);
        if (finalUrl.host !== url.host) { delete headers['x-api-key']; finalUrl.searchParams.delete('api_key'); }
        await r.arrayBuffer().catch(() => {});
        continue;
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      }
      break;
    }
    text = await r.text();
  } catch (e) {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    if (e?.name === 'AbortError') throw new GloryError('FF Glory service timed out.', { status: 504, timeout: true });
    console.error('[glory] network error', method, path, e?.cause?.code || e?.message);
    throw new GloryError('Could not reach the FF Glory service.', { status: 502, detail: String(e?.cause?.code || e?.message || '') });
  } finally {
    clearTimeout(timer);
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  }

  let data = null;
  const clean = String(text || '').replace(/^\uFEFF/, '').trim();
  const tryJson = (t) => { try { return JSON.parse(t); } catch (_) { return undefined; } };
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  data = clean ? tryJson(clean) : null;
  if (data === undefined) {
    const found = [];
    for (const line of clean.split(/\r?\n/)) {
      const t = line.replace(/^\s*data:\s*/i, '').trim();
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      if (!t) continue;
      const v = tryJson(t);
      if (v !== undefined && v !== null && typeof v === 'object') found.push(v);
    }
    if (!found.length) {
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      const m = clean.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      if (m) { const v = tryJson(m[0]); if (v !== undefined) found.push(v); }
    }
    const withId = [...found].reverse().find((o) => o && (o.group_id || o.groupId || o.success !== undefined));
    data = withId || found[found.length - 1] || null;
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  }
  const ctype = r.headers.get('content-type') || '';
  const upstreamMsg = data && typeof data === 'object' ? String(data.error || data.message || '') : '';
  const diag = `HTTP ${r.status} ${ctype.split(';')[0]} ${finalUrl.host}${finalUrl.pathname} :: ${clean.slice(0, 160).replace(/\s+/g, ' ')}`;

  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (!r.ok) {
    console.error('[glory] upstream', method, path, diag);
    throw new GloryError(friendly(r.status, upstreamMsg), { status: r.status, upstream: upstreamMsg, detail: diag });
  }
  if (data === null) {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    console.error('[glory] upstream non-JSON reply', method, path, diag);
    throw new GloryError('FF Glory service returned an unreadable reply. Please try again.', { status: 502, detail: diag, unreadable: true, rawText: clean.slice(0, 2000) });
  }
  return data;
}
// src by SRT X CHEATS. Copy right SRT X CHEATS

export async function gloryCall(method, path, { body, query, auth = true, timeoutMs = 25000 } = {}) {
  if (auth && !gloryConfigured()) {
    throw new GloryError('FF Glory is not configured on the server.', { status: 503 });
  }
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const maxTries = method === 'GET' ? 3 : 1;
  for (let i = 1; ; i++) {
    try {
      return await gloryOnce(method, path, { body, query, auth, timeoutMs });
    } catch (e) {
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      const transient = e instanceof GloryError && !e.timeout && [502, 503, 504].includes(e.status);
      if (i < maxTries && transient) { await sleepMs(600 * i); continue; }
      throw e;
    }
  }
// src by SRT X CHEATS. Copy right SRT X CHEATS
}

let pricingCache = { at: 0, data: null };
export async function getRegions() {
  if (pricingCache.data && Date.now() - pricingCache.at < 10 * 60 * 1000) return pricingCache.data;
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  try {
    const data = await gloryCall('GET', '/api/pricing', { auth: false, timeoutMs: 10000 });
    pricingCache = { at: Date.now(), data };
    return data;
  } catch (e) {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    if (pricingCache.data) return pricingCache.data;
    throw e;
  }
}

// src by SRT X CHEATS. Copy right SRT X CHEATS
export const isBasicRegion = (r) => !!r && r.enabled && String(r.tier || '').toLowerCase() !== 'premium';

const num = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && String(v ?? '').trim() !== '' ? n : null; };
export function nrpPriceForRole(role) {
  const user = num(process.env.GLORY_PRICE_USER_NRP) ?? num(process.env.GLORY_PRICE_BASIC_NRP) ?? 250;
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const reseller = num(process.env.GLORY_PRICE_RESELLER_NRP) ?? user;
  if (role === 'pro_reseller') return num(process.env.GLORY_PRICE_PRO_NRP) ?? reseller;
  if (role === 'reseller') return reseller;
  return user;
}
// src by SRT X CHEATS. Copy right SRT X CHEATS

const redact = (t) => {
  let out = String(t);
  for (const k of [process.env.GLORY_API_KEY, process.env.GLORY_MASTER_KEY]) if (k) out = out.split(k).join('***');
  return out;
// src by SRT X CHEATS. Copy right SRT X CHEATS
};
export async function diagnoseGlory() {
  const lines = [];
  for (const [path, auth] of [['/api/pricing', false], ['/api/auth/me', true], ['/api/client/my-groups', true]]) {
    try {
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      const r = await gloryCall('GET', path, { auth, timeoutMs: 15000 });
      const n = Array.isArray(r) ? ` (${r.length} items)` : '';
      lines.push(`${path} OK${n} ${redact(JSON.stringify(r)).slice(0, 200)}`);
    } catch (e) {
      lines.push(`${path} FAIL ${e.message} | ${redact(e.detail || '')}`);
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    }
  }
  return lines;
}
