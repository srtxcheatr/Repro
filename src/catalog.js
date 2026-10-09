// src/catalog.js — thin aggregator over the two catalog files, so
// every other file in the project (server.js, routes/user.js,
// routes/purchase.js) can keep doing
//   import { CATALOG, catalogFind, catalogForRole } from '../src/catalog.js'
// without caring which physical file a SKU's price actually lives in.
//
// - CATALOG 1  -> ./catalog1.js -> role "user"      (retail / high price)
// - CATALOG 2  -> ./catalog2.js -> role "reseller"   (your custom price)
//
// To add/edit products: edit catalog1.js and/or catalog2.js directly.
// You should not need to touch this file.

import { CATALOG } from './catalog1.js';
import { CATALOG_RESELLER } from './catalog2.js';
import { db } from './firebase.js';
import { cachedLoader, TTL } from './cache.js';

export { CATALOG, CATALOG_RESELLER };

/**
 * Looks up a product by sku for a given role.
 * role === 'reseller' -> CATALOG 2 (catalog2.js, your custom price)
 * anything else (default 'user') -> CATALOG 1 (catalog1.js, retail)
 * Falls back to CATALOG 1 if the sku is missing from CATALOG 2, so a
 * partial/incomplete catalog2.js never breaks checkout — it just
 * charges retail for that one sku instead of failing.
 */
export function catalogFind(sku, role = 'user') {
  let p;
  if (role === 'reseller') {
    p = CATALOG_RESELLER[sku] ?? CATALOG[sku] ?? null;
  } else {
    p = CATALOG[sku] ?? null;
  }
  if (p) return p;
  return applyCustomRole(customProductCache[sku], role); // whatsapp-redirect products are deliberately excluded — they never go through checkout
}

function applyCustomRole(p, role) {
  if (!p) return null;
  return { ...p, price: role === 'reseller' ? (p.priceReseller ?? p.price) : p.price };
}

/** Returns the full catalog object appropriate for a role (static, no overrides applied). */
export function catalogForRole(role = 'user') {
  return role === 'reseller' ? CATALOG_RESELLER : CATALOG;
}

// ---------------------------------------------------------------
// Maintenance overrides — admin-controlled, stored in Firestore
// (productStatus/{sku}), separate from the static catalog files so
// toggling a product on/off never needs a code deploy. Keyed by sku
// only (not per-catalog): catalog1.js and catalog2.js describe the
// SAME physical product at two price tiers, so one toggle covers both.
// ---------------------------------------------------------------

const overrides = cachedLoader(async () => {
  const snap = await db().collection('productStatus').get();
  const map = {};
  snap.forEach((d) => { map[d.id] = d.data(); });
  return map;
}, { ttlMs: TTL.catalog, name: 'productStatus' });

/**
 * All current overrides as { [sku]: { maintenance, maintenanceMessage } }.
 * Cached (TTL.catalog, default 10 min) and shared by every request; every
 * admin/employee write calls invalidateMaintenanceCache(), so changes show
 * up immediately. The purchase path does NOT use this cache; see
 * getMaintenanceForSku() below.
 */
export function getMaintenanceOverrides() {
  return overrides.get();
}

/** Call after any write to productStatus so the change is visible immediately, not after the TTL. */
export function invalidateMaintenanceCache() {
  overrides.invalidate();
}

// ---------------------------------------------------------------
// Live product ratings — computed from real, verified-purchase customer
// feedback (see routes/user.js POST/GET /feedback), not an admin-typed
// number. Keyed by product "row" (all duration variants of one product
// share a rating). Same cache-for-display pattern as everything else here.
// ---------------------------------------------------------------

// The WHOLE feedback collection is read once and kept in memory as a Map
// (docId -> doc). Averages are computed from that Map with zero reads, the
// feedback page is served from it too, and a newly submitted review is
// patched in with recordFeedback() — one changed doc never costs a re-read
// of the other few hundred. It is only fully re-read after TTL.feedback.
let ratingsMemo = null;

const feedbackStore = cachedLoader(async () => {
  const snap = await db().collection('feedback').get();
  const docs = new Map();
  snap.forEach((d) => docs.set(d.id, d.data()));
  ratingsMemo = null;
  return docs;
}, { ttlMs: TTL.feedback, name: 'feedback' });

async function getProductRatings() {
  const docs = await feedbackStore.get();
  if (ratingsMemo) return ratingsMemo;

  const sums = {}; // row -> { total, count }
  for (const f of docs.values()) {
    if (!f.row || !f.stars) continue;
    if (!sums[f.row]) sums[f.row] = { total: 0, count: 0 };
    sums[f.row].total += Number(f.stars);
    sums[f.row].count += 1;
  }
  const map = {};
  for (const [row, s] of Object.entries(sums)) {
    map[row] = { rating: Math.round((s.total / s.count) * 10) / 10, reviewCount: s.count };
  }
  ratingsMemo = map;
  return map;
}

/** Newest-first feedback list (optionally for one product row), capped like the old query was. Zero extra reads. */
export async function getFeedbackList({ row = null, limit = 300 } = {}) {
  const docs = await feedbackStore.get();
  let items = [...docs.values()].filter((f) => f.createdAt);
  items.sort((a, b) => b.createdAt - a.createdAt);
  items = items.slice(0, limit);
  return row ? items.filter((f) => f.row === row) : items;
}

/** Patch ONE submitted/edited review into the cached set instead of re-reading the collection. */
export function recordFeedback(id, doc) {
  feedbackStore.patch((docs) => { docs.set(id, doc); return docs; });
  ratingsMemo = null;
}

/** Kept for compatibility — prefer recordFeedback(). */
export function invalidateRatingCache() {
  feedbackStore.invalidate();
  ratingsMemo = null;
}

// ---------------------------------------------------------------
// Custom products — admin-added directly from the panel, stored in
// Firestore (customProducts/{sku}) rather than catalog1.js/catalog2.js,
// so adding a new product line never needs a code deploy. One price
// only (no separate reseller price) — a simplification for now.
// Same 30s-cache-for-display / fresh-lookup-for-purchase split as
// maintenance overrides, for the same reason: checkout can't afford
// to miss a brand new product because the cache hadn't refreshed yet.
// ---------------------------------------------------------------

let customProductCache = {}; // also read synchronously by catalogFind()

const customProducts = cachedLoader(async () => {
  const snap = await db().collection('customProducts').get();
  const map = {};
  snap.forEach((d) => { map[d.id] = d.data(); });
  customProductCache = map;
  return map;
}, { ttlMs: TTL.catalog, name: 'customProducts' });

function refreshCustomProducts() {
  return customProducts.get();
}

export function invalidateCustomProductCache() {
  customProducts.invalidate();
}

/** Fresh (uncached) lookup for one custom-product sku — used by the purchase path when catalogFind() misses, so a just-created product is buyable immediately. */
export async function findCustomProductFresh(sku, role = 'user') {
  if (!sku) return null; // a Firestore .doc() path can't be empty — fail soft, not with an unhandled 500
  const snap = await db().collection('customProducts').doc(sku).get();
  return snap.exists ? applyCustomRole(snap.data(), role) : null;
}

/** Direct read of one custom product's raw stored doc (both prices, no role applied) — for the admin edit form, which needs to show/edit both at once. */
export async function getCustomProductRaw(sku) {
  const snap = await db().collection('customProducts').doc(sku).get();
  return snap.exists ? snap.data() : null;
}

export async function deleteCustomProduct(sku) {
  await db().collection('customProducts').doc(sku).delete();
  invalidateCustomProductCache();
}

// ---------------------------------------------------------------
// WhatsApp-redirect products — a third product type alongside the
// automated (static + custom) catalog. No duration, no checkout, no
// key delivery: the "buy" action is just a deep link into WhatsApp
// with a pre-filled message. Never merged into catalogFind(), so
// these can never accidentally enter the automated purchase flow.
// ---------------------------------------------------------------

const whatsappProducts = cachedLoader(async () => {
  const snap = await db().collection('whatsappProducts').get();
  const map = {};
  snap.forEach((d) => { map[d.id] = d.data(); });
  return map;
}, { ttlMs: TTL.catalog, name: 'whatsappProducts' });

function refreshWhatsappProducts() {
  return whatsappProducts.get();
}

export function invalidateWhatsappProductCache() {
  whatsappProducts.invalidate();
}

export async function getWhatsappProductRaw(id) {
  const snap = await db().collection('whatsappProducts').doc(id).get();
  return snap.exists ? snap.data() : null;
}

export async function deleteWhatsappProduct(id) {
  await db().collection('whatsappProducts').doc(id).delete();
  invalidateWhatsappProductCache();
}

/**
 * A role's catalog with maintenance overrides merged on top. Never
 * mutates the underlying static objects (they're shared module-level
 * state) — returns a shallow copy with only the overridden skus replaced.
 *
 * Fails OPEN to the static catalog: if the Firestore override lookup
 * has any problem (network blip, cold start, etc.), the storefront
 * should still show products rather than break entirely over what is,
 * for display purposes, a nice-to-have layer on top of a base that has
 * zero external dependencies of its own.
 */
export async function getLiveCatalog(role = 'user') {
  let base = { ...catalogForRole(role) };

  try {
    const custom = await refreshCustomProducts();
    for (const [sku, p] of Object.entries(custom)) base[sku] = applyCustomRole(p, role);
  } catch (e) {
    console.error('[catalog] custom products unavailable, showing static catalog only:', e);
  }

  try {
    const whatsapp = await refreshWhatsappProducts();
    for (const [id, p] of Object.entries(whatsapp)) {
      base[id] = { ...applyCustomRole(p, role), type: 'whatsapp', row: p.name, name: p.name };
    }
  } catch (e) {
    console.error('[catalog] whatsapp products unavailable:', e);
  }

  let overrides;
  try {
    overrides = await getMaintenanceOverrides();
  } catch (e) {
    console.error('[catalog] maintenance override lookup failed — showing the catalog without overrides:', e);
    return applyRatings(base);
  }
  if (Object.keys(overrides).length === 0) return applyRatings(base);

  const merged = { ...base };
  for (const sku of Object.keys(overrides)) {
    if (!merged[sku]) continue;
    const o = overrides[sku];
    merged[sku] = {
      ...merged[sku],
      maintenance: !!o.maintenance,
      maintenanceMessage: o.maintenance ? (o.maintenanceMessage || merged[sku].maintenanceMessage || 'This product is temporarily under maintenance.') : undefined,
      // Out of stock is its own flag, not a maintenance sub-state — toggling
      // it for sku_1550 (e.g. the 3-day variant) never touches sku_1551 (7-day)
      // or any other sku, even though they share the same product "row".
      outOfStock: !!o.outOfStock,
      outOfStockMessage: o.outOfStock ? (o.outOfStockMessage || 'Out of stock — check back soon.') : undefined,
      // Editable display fields — only present once an admin has edited a
      // STATIC (catalog1/2.js) product; custom/whatsapp products are edited
      // in their own collection directly instead, so this rarely applies to them.
      ...(o.image !== undefined ? { image: o.image } : {}),
      ...(o.name !== undefined ? { name: o.name } : {}),
      ...(o.duration !== undefined ? { duration: o.duration } : {}),
      ...(o.pid !== undefined ? { pid: o.pid } : {}),
      ...(o.price !== undefined ? { price: role === 'reseller' ? (o.priceReseller ?? o.price) : o.price } : {}),
    };
  }
  return applyRatings(merged);
}

/** Overwrites any static/override `rating` with the real customer-feedback average (undefined/null if nobody has reviewed it yet — never a stale hand-typed number). */
async function applyRatings(catalogObj) {
  let ratings;
  try {
    ratings = await getProductRatings();
  } catch (e) {
    console.error('[catalog] rating lookup failed, showing catalog without ratings:', e);
    return catalogObj;
  }
  const out = { ...catalogObj };
  for (const sku of Object.keys(out)) {
    const r = ratings[out[sku].row];
    out[sku] = { ...out[sku], rating: r ? r.rating : null, reviewCount: r ? r.reviewCount : 0 };
  }
  return out;
}

/**
 * Fresh (uncached) maintenance state for a single sku — used by the
 * purchase path, where "up to 30s stale" isn't good enough: this is
 * the actual gate on whether money moves.
 */
export async function getMaintenanceForSku(sku) {
  const snap = await db().collection('productStatus').doc(sku).get();
  if (!snap.exists) return { maintenance: false, outOfStock: false };
  const d = snap.data();
  return {
    maintenance: !!d.maintenance,
    maintenanceMessage: d.maintenanceMessage || null,
    outOfStock: !!d.outOfStock,
    outOfStockMessage: d.outOfStockMessage || null,
  };
}
