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
  if (role === 'reseller') {
    return CATALOG_RESELLER[sku] ?? CATALOG[sku] ?? null;
  }
  return CATALOG[sku] ?? null;
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

let overrideCache = null;
let overrideCacheAt = 0;
const OVERRIDE_CACHE_TTL_MS = 30 * 1000;

/**
 * All current overrides as { [sku]: { maintenance, maintenanceMessage } }.
 * Cached for 30s — fine for catalog *display*, which doesn't need to be
 * perfectly real-time. The purchase path does NOT use this cache; see
 * getMaintenanceForSku() below.
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

/**
 * A role's catalog with maintenance overrides merged on top. Never
 * mutates the underlying static objects (they're shared module-level
 * state) — returns a shallow copy with only the overridden skus replaced.
 */
export async function getLiveCatalog(role = 'user') {
  const base = catalogForRole(role);
  const overrides = await getMaintenanceOverrides();
  if (Object.keys(overrides).length === 0) return base;

  const merged = { ...base };
  for (const sku of Object.keys(overrides)) {
    if (!merged[sku]) continue;
    const o = overrides[sku];
    merged[sku] = {
      ...merged[sku],
      maintenance: !!o.maintenance,
      maintenanceMessage: o.maintenance ? (o.maintenanceMessage || merged[sku].maintenanceMessage || 'This product is temporarily under maintenance.') : undefined,
    };
  }
  return merged;
}

/**
 * Fresh (uncached) maintenance state for a single sku — used by the
 * purchase path, where "up to 30s stale" isn't good enough: this is
 * the actual gate on whether money moves.
 */
export async function getMaintenanceForSku(sku) {
  const snap = await db().collection('productStatus').doc(sku).get();
  if (!snap.exists) return { maintenance: false };
  const d = snap.data();
  return { maintenance: !!d.maintenance, maintenanceMessage: d.maintenanceMessage || null };
}
