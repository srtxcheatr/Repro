// src/apiMatch.js — pure helpers (no database, no network) for matching what a
// reseller sends to the API ("product_id" + "duration") against the products
// stored in Firestore.
//
// Why normalise at all: the same duration gets typed many ways by many people —
// "1 Day", "1 DaYs", "1_day", "1day", "7 days". They all mean the same thing, so
// all of them must find the same product. Matching is case-insensitive, treats
// "_" "-" "+" "." as spaces, ignores plural "s" on time units, and splits
// "1day" into "1 day".

const UNITS = 'second|minute|min|hour|hr|day|week|month|year';

export function normDuration(input) {
  return String(input ?? '')
    .toLowerCase()
    .replace(/[_\-+.]+/g, ' ')                       // 1_day / 1-day  -> 1 day
    .replace(/(\d)([a-z])/g, '$1 $2')                // 1day           -> 1 day
    .replace(new RegExp(`\\b(${UNITS})s\\b`, 'g'), '$1') // days -> day, hours -> hour
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The duration text a reseller must send for this product. An admin can set a
 * clean, API-facing label (apiDuration, e.g. "1 Day") that differs from the
 * label sent to the upstream provider (duration, e.g. "1 DaYs"). If no
 * apiDuration is set, the normal duration label is used.
 */
export function apiLabel(product) {
  const custom = String(product?.apiDuration ?? '').trim();
  return custom || String(product?.duration ?? '').trim();
}

/** Allowed characters for an admin-entered API duration label. */
export const API_DURATION_RE = /^[A-Za-z0-9 _.+\-]{1,40}$/;

/**
 * Find the single product matching pid + duration.
 * `products` is an array of { sku, pid, duration, apiDuration, ... }.
 * Accepts the API label OR the plain duration label, so a reseller who copies
 * either one still gets the right product.
 *
 * Returns { product } on success, or { error: 'NOT_FOUND' | 'AMBIGUOUS' }.
 */
export function matchProduct(products, pid, durationInput) {
  const wantPid = String(pid ?? '').trim();
  const wantDur = normDuration(durationInput);
  if (!wantPid || !wantDur) return { error: 'NOT_FOUND' };

  const samePid = products.filter((p) => String(p.pid ?? '').trim() === wantPid);

  // Tier 1: the API-facing label. Tier 2 (only if tier 1 finds nothing): the
  // plain duration label. Keeping them separate means an exact API label can
  // never be hijacked by some other product's plain duration text.
  let hits = samePid.filter((p) => normDuration(apiLabel(p)) === wantDur);
  if (hits.length === 0) hits = samePid.filter((p) => normDuration(p.duration) === wantDur);

  if (hits.length === 0) return { error: 'NOT_FOUND' };
  if (hits.length > 1) return { error: 'AMBIGUOUS', skus: hits.map((h) => h.sku) };
  return { product: hits[0] };
}

/**
 * Would giving a product this (pid, label) collide with another product?
 * Used by the admin routes so an ambiguous setup is rejected when it is
 * created, with a clear message, instead of failing later for a reseller.
 */
export function findLabelConflict(products, pid, label, excludeSku = null) {
  const wantPid = String(pid ?? '').trim();
  const wantDur = normDuration(label);
  return products.find((p) =>
    p.sku !== excludeSku &&
    String(p.pid ?? '').trim() === wantPid &&
    normDuration(apiLabel(p)) === wantDur
  ) || null;
}

/** Coerce whatever the upstream returned as a "key" into a plain string. */
export function keyToString(key) {
  if (Array.isArray(key)) return key.join('');
  if (key === null || key === undefined) return '';
  return String(key).trim();
}
