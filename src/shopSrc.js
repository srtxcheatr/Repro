// src by SRT X CHEATS. Copy right SRT X CHEATS
// Helpers for the "shop project" (store source code) product type.
import crypto from 'crypto';

// Free-hosting domains a buyer can pick for their shop / admin-panel subdomain.
// Override with SHOPSRC_DOMAINS="a.com,b.com" (comma separated) if the list changes.
const DEFAULT_DOMAINS = ['ct.ws', 'free.je', 'free.nf', 'freedev.app', 'rf.gd', 'site.je', 'gt.tc', 'gamer.free', 'gamer.gd'];
export function shopDomains() {
  const raw = String(process.env.SHOPSRC_DOMAINS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  return raw.length ? raw : DEFAULT_DOMAINS;
}

export const MAX_SUBMITS = 3;
export const MAX_DOWNLOADS = Number(process.env.SHOPSRC_MAX_DOWNLOADS) > 0 ? Number(process.env.SHOPSRC_MAX_DOWNLOADS) : 5;
export const DOWNLOAD_TOKEN_TTL_MS = 90_000;

export const DEFAULT_FEATURES = [
  { text: 'User store', ok: true },
  { text: 'Full SRC source code', ok: true },
  { text: 'Sub_domain', ok: true },
  { text: 'Costume domain', ok: false },
  { text: 'automatic build in under 7 day', ok: true },
  { text: 'SRC (source code ) available', ok: true },
];

// Accepts an array of {text, ok} or a multi-line string. A line ending/starting with ❌ is "not included",
// ✅ (or no mark) is "included".
export function parseFeatures(input) {
  let list = [];
  if (Array.isArray(input)) {
    list = input.map((f) => (typeof f === 'string' ? parseLine(f) : { text: String(f?.text || '').trim(), ok: f?.ok !== false }));
  } else if (typeof input === 'string') {
    list = input.split(/\r?\n/).map(parseLine);
  }
  return list.filter((f) => f.text).slice(0, 20).map((f) => ({ text: f.text.slice(0, 80), ok: !!f.ok }));
}
function parseLine(line) {
  const s = String(line || '');
  const ok = !/❌|✗|✘/.test(s);
  return { text: s.replace(/[✅✔☑❌✗✘]/gu, '').replace(/\s+/g, ' ').trim(), ok };
}

export function shopSrcPrice(p, role) {
  if (role === 'pro_reseller') return Number(p.priceProReseller ?? p.priceReseller ?? p.price);
  if (role === 'reseller') return Number(p.priceReseller ?? p.price);
  return Number(p.price);
}

// ---- subdomain validation -----------------------------------------------------------------
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{1,28})[a-z0-9]$/;
const RESERVED = new Set(['www', 'admin', 'mail', 'ftp', 'api', 'cpanel', 'ns1', 'ns2', 'srtxcheats', 'srtx', 'cheats', 'store', 'panel']);

export function cleanSub(sub, domain, what) {
  const name = String(sub || '').trim().toLowerCase();
  const dom = String(domain || '').trim().toLowerCase();
  if (!LABEL_RE.test(name)) throw new Error(`${what}: use 3–30 letters/numbers (a hyphen is allowed in the middle)`);
  if (RESERVED.has(name)) throw new Error(`${what}: "${name}" is reserved — pick another name`);
  if (!shopDomains().includes(dom)) throw new Error(`${what}: pick one of the listed domains`);
  return { name, domain: dom, full: `${name}.${dom}` };
}

// ---- stateless signed download token ------------------------------------------------------
function secret() {
  const s = process.env.SHOPSRC_TOKEN_SECRET || process.env.ADMIN_SECRET;
  if (!s) throw new Error('SHOPSRC_TOKEN_SECRET (or ADMIN_SECRET) is not set on the server');
  return s;
}
const b64u = (buf) => Buffer.from(buf).toString('base64url');

export function signDownloadToken({ orderId, uid }) {
  const payload = b64u(JSON.stringify({ o: orderId, u: uid, e: Date.now() + DOWNLOAD_TOKEN_TTL_MS, n: crypto.randomBytes(8).toString('hex') }));
  const sig = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyDownloadToken(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const want = crypto.createHmac('sha256', secret()).update(payload).digest();
  let got;
  try { got = Buffer.from(sig, 'base64url'); } catch { return null; }
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!d?.o || !d?.u || !d?.n || Number(d.e) < Date.now()) return null;
    return d;
  } catch { return null; }
}

// each token can start only one download (in-memory; tokens live 90 s anyway)
const usedNonces = new Map();
export function consumeNonce(n) {
  const now = Date.now();
  for (const [k, t] of usedNonces) if (now - t > DOWNLOAD_TOKEN_TTL_MS * 2) usedNonces.delete(k);
  if (usedNonces.has(n)) return false;
  usedNonces.set(n, now);
  return true;
}
