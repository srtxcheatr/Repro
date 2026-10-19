// src by SRT X CHEATS. Copy right SRT X CHEATS
import { db } from './firebase.js';
import { getMaintenanceOverrides, getCustomProductsCached } from './srt_storage_product.js';
import { matchProduct, apiLabel } from './apiMatch.js';

// src by SRT X CHEATS. Copy right SRT X CHEATS
export const resellerPrice = (p) => Number(p.priceReseller ?? p.price);

const toStatus = (maintenance, outOfStock) => (maintenance ? 'maintenance' : outOfStock ? 'out_of_stock' : 'available');

export async function listApiProducts() {
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const [custom, overrides] = await Promise.all([
    getCustomProductsCached(),
    getMaintenanceOverrides().catch(() => ({})),
  ]);

  // src by SRT X CHEATS. Copy right SRT X CHEATS
  return Object.entries(custom)
    .map(([sku, d]) => {
      const o = overrides[sku] || {};
      return {
        sku,
        // src by SRT X CHEATS. Copy right SRT X CHEATS
        row: d.row || d.name || '',
        name: d.name || '',
        pid: String(d.pid ?? ''),
        label: apiLabel(d),
        price: resellerPrice(d),
        // src by SRT X CHEATS. Copy right SRT X CHEATS
        requiresAndroidId: !!d.requiresAndroidId,
        status: toStatus(!!o.maintenance, !!o.outOfStock),
      };
    })
    .sort((a, b) => a.row.localeCompare(b.row) || a.price - b.price);
// src by SRT X CHEATS. Copy right SRT X CHEATS
}

export async function loadPidProducts(pid) {
  const snap = await db().collection('customProducts').where('pid', '==', String(pid ?? '').trim()).get();
  return snap.docs.map((d) => ({ sku: d.id, ...d.data() }));
// src by SRT X CHEATS. Copy right SRT X CHEATS
}

export async function findApiProduct(pid, duration) {
  const products = await loadPidProducts(pid);
  const m = matchProduct(products, pid, duration);
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (m.error) return m;
  const p = m.product;
  return { product: { ...p, price: resellerPrice(p), label: apiLabel(p) } };
}
