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

/** Returns the full catalog object appropriate for a role. */
export function catalogForRole(role = 'user') {
  return role === 'reseller' ? CATALOG_RESELLER : CATALOG;
}
