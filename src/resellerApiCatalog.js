// src by SRT X CHEATS. Copy right SRT X CHEATS
import { db } from './firebase.js';
import { getMaintenanceOverrides, getCustomProductsCached } from './srt_storage_product.js';
import { matchProduct, apiLabel } from './apiMatch.js';
import { tierPrice } from './srt_storage_product.js';

// src by SRT X CHEATS. Copy right SRT X CHEATS
// Price for the caller's role: user -> price, reseller -> priceReseller, pro_reseller -> priceProReseller.
// Same rule as the website checkout (tierPrice) so API and web can never disagree.
export const resellerPrice = (p, role = 'reseller') => Number(tierPrice(p, role === 'user' ? 'reseller' : role));

const toStatus = (maintenance, outOfStock) => (maintenance ? 'maintenance' : outOfStock ? 'out_of_stock' : 'available');

export async function listApiProducts(role = 'reseller') {
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const [custom, overrides] = await Promise.all([
    getCustomProductsCached(),
    getMaintenanceOverrides().catch(() => ({})),
  ]);

  // src by SRT X CHEATS. Copy right SRT X CHEATS
  return Object.entries(custom)
    .filter(([, d]) => !d.stockMode)
    .map(([sku, d]) => {
      const o = overrides[sku] || {};
      return {
        sku,
        // src by SRT X CHEATS. Copy right SRT X CHEATS
        row: d.row || d.name || '',
        name: d.name || '',
        pid: String(d.pid ?? ''),
        label: apiLabel(d),
        price: resellerPrice(d, role),
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

export async function findApiProduct(pid, duration, role = 'reseller') {
  const products = (await loadPidProducts(pid)).filter((x) => !x.stockMode);
  const m = matchProduct(products, pid, duration);
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (m.error) return m;
  const p = m.product;
  return { product: { ...p, price: resellerPrice(p, role), label: apiLabel(p) } };
}

// ───────────────────────── PI KEY catalog ─────────────────────────
// Percent added on top of the caller's own tier price (user / reseller / pro_reseller).
// Default 30. Change with env PI_MARKUP_PERCENT (e.g. 25).
const PI_MARKUP = Number(process.env.PI_MARKUP_PERCENT) >= 0 && process.env.PI_MARKUP_PERCENT !== undefined && process.env.PI_MARKUP_PERCENT !== ''
  ? Number(process.env.PI_MARKUP_PERCENT) : 30;
export const PI_MARKUP_PERCENT = PI_MARKUP;
const round2 = (n) => Math.round(n * 100) / 100;

// Grouped by product: { name, image, pid, durations:[{ duration, price, status }] }
export async function listPiProducts(role = 'user') {
  const [custom, overrides] = await Promise.all([
    getCustomProductsCached(),
    getMaintenanceOverrides().catch(() => ({})),
  ]);
  const groups = new Map();
  for (const [sku, d] of Object.entries(custom)) {
    if (d.stockMode) continue;
    const base = Number(tierPrice(d, role));
    if (!Number.isFinite(base) || base <= 0) continue;
    const o = overrides[sku] || {};
    const name = d.row || d.name || '';
    const pid = String(d.pid ?? '');
    const k = `${name}\u0000${pid}`;
    if (!groups.has(k)) groups.set(k, { name, image: d.image || '', pid, durations: [] });
    groups.get(k).durations.push({
      duration: apiLabel(d),
      price: round2(base * (1 + PI_MARKUP / 100)),
      status: toStatus(!!o.maintenance, !!o.outOfStock),
    });
  }
  const out = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  out.forEach((g) => g.durations.sort((a, b) => a.price - b.price));
  return out;
}
