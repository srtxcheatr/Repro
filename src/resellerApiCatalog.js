// src/resellerApiCatalog.js — product list + lookup for the reseller API.
//
// Reads Firestore's `customProducts` collection directly. That is where every
// product in this store lives (catalog1.js / catalog2.js are empty — see
// CHANGES.md #1). Reads are FRESH, not from the 30-second display cache in
// catalog.js: this decides what a reseller is charged, so a price change or a
// newly added product must apply on the very next request.

import { db } from './firebase.js';
import { getMaintenanceOverrides } from './catalog.js';
import { matchProduct, apiLabel } from './apiMatch.js';

/** Resellers always pay the reseller price (falls back to the normal price if none was set). */
export const resellerPrice = (p) => Number(p.priceReseller ?? p.price);

const toStatus = (maintenance, outOfStock) => (maintenance ? 'maintenance' : outOfStock ? 'out_of_stock' : 'available');

/** Every API-orderable product, shaped for display (the `products` action and apicontact.php). */
export async function listApiProducts() {
  const [snap, overrides] = await Promise.all([
    db().collection('customProducts').get(),
    getMaintenanceOverrides().catch(() => ({})), // display only — fail open to "available"
  ]);

  return snap.docs
    .map((doc) => {
      const d = doc.data();
      const o = overrides[doc.id] || {};
      return {
        sku: doc.id,
        row: d.row || d.name || '',
        name: d.name || '',
        pid: String(d.pid ?? ''),
        label: apiLabel(d),
        price: resellerPrice(d),
        requiresAndroidId: !!d.requiresAndroidId,
        status: toStatus(!!o.maintenance, !!o.outOfStock),
      };
    })
    .sort((a, b) => a.row.localeCompare(b.row) || a.price - b.price);
}

/** All products sharing one pid — used by the admin routes for duplicate checks. */
export async function loadPidProducts(pid) {
  const snap = await db().collection('customProducts').where('pid', '==', String(pid ?? '').trim()).get();
  return snap.docs.map((d) => ({ sku: d.id, ...d.data() }));
}

/** Resolve (product_id, duration) -> exactly one product, with its reseller price. */
export async function findApiProduct(pid, duration) {
  const products = await loadPidProducts(pid);
  const m = matchProduct(products, pid, duration);
  if (m.error) return m;
  const p = m.product;
  return { product: { ...p, price: resellerPrice(p), label: apiLabel(p) } };
}
