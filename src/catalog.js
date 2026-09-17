// src/catalog.js — thin aggregator over the two catalog files, PLUS
// admin-created custom products and live overrides, so every other
// file in the project (server.js, routes/user.js, routes/purchase.js)
// can keep doing
//   import { catalogFind, getLiveCatalog } from '../src/catalog.js'
// without caring whether a sku's data lives in the static files or was
// added later from the admin panel.
//
// - CATALOG 1  -> ./catalog1.js -> role "user"      (retail / high price)
// - CATALOG 2  -> ./catalog2.js -> role "reseller"   (your custom price)
// - customProducts/{sku} in Firestore -> products added from the admin
//   panel after deploy, with no code change needed.
//
// To edit the ORIGINAL hand-written products: edit catalog1.js/catalog2.js.
// New products added via the admin panel live in Firestore instead.

import { CATALOG } from './catalog1.js';
import { CATALOG_RESELLER } from './catalog2.js';
import { db } from './firebase.js';

export { CATALOG, CATALOG_RESELLER };

/**
 * Looks up a product by sku for a given role. Static catalogs only —
 * callers that also need custom (admin-added) products should go
 * through getLiveCatalog() instead. catalogFind() is used by the
 * purchase path, which separately re-checks custom products (see
 * routes/purchase.js) since that path cares about freshness more than
 * this cached/simple lookup can offer anyway.
 */
export function catalogFind(sku, role = 'user') {
  if (role === 'reseller') {
    return CATALOG_RESELLER[sku] ?? CATALOG[sku] ?? null;
  }
  return CATALOG[sku] ?? null;
}

/** Returns the full static catalog object appropriate for a role (no overrides, no custom products). */
export function catalogForRole(role = 'user') {
  return role === 'reseller' ? CATALOG_RESELLER : CATALOG;
}

// ---------------------------------------------------------------
// Custom products — created from the admin panel, stored in Firestore
// (customProducts/{sku}) instead of the static files, so adding a new
// product never needs a code deploy. Each doc holds both price tiers
// so one write covers retail + reseller, same spirit as the static
// catalogs describing both.
// ---------------------------------------------------------------

let customCache = null;
let customCacheAt = 0;
const CUSTOM_CACHE_TTL_MS = 30 * 1000;

export async function getCustomProductDocs() {
  const now = Date.now();
  if (customCache && now - customCacheAt < CUSTOM_CACHE_TTL_MS) return customCache;
  const snap = await db().collection('customProducts').get();
  const map = {};
  snap.forEach((d) => { map[d.id] = d.data(); });
  customCache = map;
  customCacheAt = now;
  return map;
}

export function invalidateCustomProductsCache() {
  customCache = null;
  customCacheAt = 0;
}

function customProductsForRole(docs, role) {
  const out = {};
  for (const [sku, d] of Object.entries(docs)) {
    out[sku] = {
      pid: d.pid, row: d.row, name: d.name, duration: d.duration,
      price: role === 'reseller' ? Number(d.priceReseller ?? d.price) : Number(d.price),
      image: d.image || '',
    };
  }
  return out;
}

// ---------------------------------------------------------------
// Maintenance + out-of-stock overrides — admin-controlled, stored in
// Firestore (productStatus/{sku}), separate from catalog data so
// toggling either never needs a code deploy.
//
// These are deliberately DIFFERENT concepts:
// - maintenance: takes the WHOLE product card down (all durations),
//   for when the product itself is broken/being worked on.
// - outOfStock: per DURATION only — e.g. "3 day" sold out while
//   "7 day"/"15 day" stay buyable. Never affects sibling durations.
// ---------------------------------------------------------------

let overrideCache = null;
let overrideCacheAt = 0;
const OVERRIDE_CACHE_TTL_MS = 30 * 1000;

/**
 * All current overrides as { [sku]: { maintenance, maintenanceMessage, outOfStock } }.
 * Cached for 30s — fine for catalog *display*. The purchase path does
 * NOT use this cache; see getProductStatusForSku() below.
 */
export async function getMaintenanceOverrides() {
  const now = Date.now();
  if (overrideCache && now - overrideCacheAt < OVERRIDE_CACHE_TTL_MS) return overrideCache;

  const snap = await db().collection('productStatus').get();
  const map = {};
  snap.forEach((d) => { map[d.id] = d.data(); });
  overrideCache = map;
  overrideCacheAt = now;
  return map;
}

/** Call after any write to productStatus so the change is visible immediately, not after the TTL. */
export function invalidateMaintenanceCache() {
  overrideCache = null;
  overrideCacheAt = 0;
}

// ---------------------------------------------------------------
// Real customer ratings — replaces the old static per-row placeholder
// values. Aggregated in Firestore (productRatings/{row}) by
// routes/user.js whenever someone submits a review. Zero reviews means
// zero rating shown (the frontend shows "No ratings yet" rather than a
// made-up number).
// ---------------------------------------------------------------

let ratingsCache = null;
let ratingsCacheAt = 0;
const RATINGS_CACHE_TTL_MS = 30 * 1000;

export async function getProductRatings() {
  const now = Date.now();
  if (ratingsCache && now - ratingsCacheAt < RATINGS_CACHE_TTL_MS) return ratingsCache;
  const snap = await db().collection('productRatings').get();
  const map = {};
  snap.forEach((d) => {
    const data = d.data();
    const count = Number(data.count || 0);
    map[d.id] = { rating: count > 0 ? Number((data.totalStars / count).toFixed(1)) : null, count };
  });
  ratingsCache = map;
  ratingsCacheAt = now;
  return map;
}

export function invalidateRatingsCache() {
  ratingsCache = null;
  ratingsCacheAt = 0;
}

/**
 * A role's full live catalog: static + custom products, with
 * maintenance/out-of-stock overrides and real ratings merged on top.
 * Never mutates the underlying static objects (shared module-level
 * state) — always returns a fresh merged copy.
 *
 * Fails OPEN to the static catalog if any of the Firestore-backed
 * layers error — a broken enhancement should never take the whole
 * storefront down when the base catalog data has zero external
 * dependencies of its own.
 */
export async function getLiveCatalog(role = 'user') {
  const base = catalogForRole(role);
  let merged = { ...base };

  try {
    const customDocs = await getCustomProductDocs();
    Object.assign(merged, customProductsForRole(customDocs, role));
  } catch (e) {
    console.error('[catalog] custom product lookup failed — showing static catalog only:', e);
  }

  try {
    const ratings = await getProductRatings();
    for (const sku of Object.keys(merged)) {
      const r = ratings[merged[sku].row];
      if (r) merged[sku] = { ...merged[sku], rating: r.rating, ratingCount: r.count };
    }
  } catch (e) {
    console.error('[catalog] rating lookup failed — showing catalog without ratings:', e);
  }

  try {
    const overrides = await getMaintenanceOverrides();
    for (const sku of Object.keys(overrides)) {
      if (!merged[sku]) continue;
      const o = overrides[sku];
      merged[sku] = {
        ...merged[sku],
        maintenance: !!o.maintenance,
        maintenanceMessage: o.maintenance ? (o.maintenanceMessage || merged[sku].maintenanceMessage || 'This product is temporarily under maintenance.') : undefined,
        outOfStock: !!o.outOfStock,
      };
    }
  } catch (e) {
    console.error('[catalog] status override lookup failed — showing catalog without them:', e);
  }

  return merged;
}

/**
 * Fresh (uncached) status for a single sku — used by the purchase
 * path, where "up to 30s stale" isn't good enough since this actually
 * gates whether money moves.
 */
export async function getProductStatusForSku(sku) {
  const snap = await db().collection('productStatus').doc(sku).get();
  if (!snap.exists) return { maintenance: false, outOfStock: false };
  const d = snap.data();
  return {
    maintenance: !!d.maintenance,
    maintenanceMessage: d.maintenanceMessage || null,
    outOfStock: !!d.outOfStock,
  };
}

/** Fresh (uncached) product lookup by sku+role — static, then custom. Used by the purchase path. */
export async function findProductLive(sku, role = 'user') {
  const staticHit = catalogFind(sku, role);
  if (staticHit) return staticHit;
  const snap = await db().collection('customProducts').doc(sku).get();
  if (!snap.exists) return null;
  const d = snap.data();
  return {
    pid: d.pid, row: d.row, name: d.name, duration: d.duration,
    price: role === 'reseller' ? Number(d.priceReseller ?? d.price) : Number(d.price),
    image: d.image || '',
  };
}
