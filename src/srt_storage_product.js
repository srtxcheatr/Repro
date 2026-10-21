// src by SRT X CHEATS. Copy right SRT X CHEATS
import { CATALOG } from './catalog1.js';
import { CATALOG_RESELLER } from './catalog2.js';
import { CATALOG_PRO } from './catalog3.js';
import { db } from './firebase.js';
// src by SRT X CHEATS. Copy right SRT X CHEATS
import { cachedLoader, TTL } from './cache.js';
import { DEFAULT_FEATURES } from './shopSrc.js';

export { CATALOG, CATALOG_RESELLER, CATALOG_PRO };

export function catalogFind(sku, role = 'user') {
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  let p;
  if (role === 'pro_reseller') {
    p = CATALOG_PRO[sku] ?? CATALOG_RESELLER[sku] ?? CATALOG[sku] ?? null;
  } else if (role === 'reseller') {
    p = CATALOG_RESELLER[sku] ?? CATALOG[sku] ?? null;
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  } else {
    p = CATALOG[sku] ?? null;
  }
  if (p) return p;
  return applyCustomRole(customProductCache[sku], role);
// src by SRT X CHEATS. Copy right SRT X CHEATS
}

export function tierPrice(p, role) {
  if (role === 'pro_reseller') return p.priceProReseller ?? p.priceReseller ?? p.price;
  if (role === 'reseller') return p.priceReseller ?? p.price;
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  return p.price;
}

function applyCustomRole(p, role) {
  if (!p) return null;
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  return { ...p, price: tierPrice(p, role) };
}

export function catalogForRole(role = 'user') {
  if (role === 'pro_reseller') return { ...CATALOG_RESELLER, ...CATALOG_PRO };
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  return role === 'reseller' ? CATALOG_RESELLER : CATALOG;
}

const overrides = cachedLoader(async () => {
  const snap = await db().collection('productStatus').get();
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const map = {};
  snap.forEach((d) => { map[d.id] = d.data(); });
  return map;
}, { ttlMs: TTL.catalog, name: 'productStatus', versionKey: 'catalog' });

// src by SRT X CHEATS. Copy right SRT X CHEATS
export function getMaintenanceOverrides() {
  return overrides.get();
}

export function invalidateMaintenanceCache() {
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  overrides.invalidate();
}

let ratingsMemo = null;

// src by SRT X CHEATS. Copy right SRT X CHEATS
const feedbackStore = cachedLoader(async () => {
  const snap = await db().collection('feedback').get();
  const docs = new Map();
  snap.forEach((d) => docs.set(d.id, d.data()));
  ratingsMemo = null;
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  return docs;
}, { ttlMs: TTL.feedback, name: 'feedback', versionKey: 'feedback' });

async function getProductRatings() {
  const docs = await feedbackStore.get();
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (ratingsMemo) return ratingsMemo;

  const sums = {};
  for (const f of docs.values()) {
    if (!f.row || !f.stars) continue;
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    if (!sums[f.row]) sums[f.row] = { total: 0, count: 0 };
    sums[f.row].total += Number(f.stars);
    sums[f.row].count += 1;
  }
  const map = {};
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  for (const [row, s] of Object.entries(sums)) {
    map[row] = { rating: Math.round((s.total / s.count) * 10) / 10, reviewCount: s.count };
  }
  ratingsMemo = map;
  return map;
// src by SRT X CHEATS. Copy right SRT X CHEATS
}

export async function getFeedbackList({ row = null, limit = 300 } = {}) {
  const docs = await feedbackStore.get();
  let items = [...docs.values()].filter((f) => f.createdAt);
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  items.sort((a, b) => b.createdAt - a.createdAt);
  items = items.slice(0, limit);
  return row ? items.filter((f) => f.row === row) : items;
}

// src by SRT X CHEATS. Copy right SRT X CHEATS
export function recordFeedback(id, doc) {
  feedbackStore.patch((docs) => { docs.set(id, doc); return docs; });
  ratingsMemo = null;
}

// src by SRT X CHEATS. Copy right SRT X CHEATS
export function invalidateRatingCache() {
  feedbackStore.invalidate();
  ratingsMemo = null;
}

// src by SRT X CHEATS. Copy right SRT X CHEATS
let customProductCache = {};

const customProducts = cachedLoader(async () => {
  const snap = await db().collection('customProducts').get();
  const map = {};
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  snap.forEach((d) => { map[d.id] = d.data(); });
  customProductCache = map;
  return map;
}, { ttlMs: TTL.catalog, name: 'customProducts', versionKey: 'catalog' });

// src by SRT X CHEATS. Copy right SRT X CHEATS
export const getCustomProductsCached = () => customProducts.get();

function refreshCustomProducts() {
  return customProducts.get();
}
// src by SRT X CHEATS. Copy right SRT X CHEATS

export function invalidateCustomProductCache() {
  customProducts.invalidate();
}

// src by SRT X CHEATS. Copy right SRT X CHEATS
export async function findCustomProductFresh(sku, role = 'user') {
  if (!sku) return null;
  const snap = await db().collection('customProducts').doc(sku).get();
  return snap.exists ? applyCustomRole(snap.data(), role) : null;
}
// src by SRT X CHEATS. Copy right SRT X CHEATS

export async function getCustomProductRaw(sku) {
  const snap = await db().collection('customProducts').doc(sku).get();
  return snap.exists ? snap.data() : null;
}
// src by SRT X CHEATS. Copy right SRT X CHEATS

export async function deleteCustomProduct(sku) {
  await db().collection('customProducts').doc(sku).delete();
  invalidateCustomProductCache();
}
// src by SRT X CHEATS. Copy right SRT X CHEATS

const whatsappProducts = cachedLoader(async () => {
  const snap = await db().collection('whatsappProducts').get();
  const map = {};
  snap.forEach((d) => { map[d.id] = d.data(); });
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  return map;
}, { ttlMs: TTL.catalog, name: 'whatsappProducts', versionKey: 'catalog' });

function refreshWhatsappProducts() {
  return whatsappProducts.get();
// src by SRT X CHEATS. Copy right SRT X CHEATS
}

export function invalidateWhatsappProductCache() {
  whatsappProducts.invalidate();
}
// src by SRT X CHEATS. Copy right SRT X CHEATS

export async function getWhatsappProductRaw(id) {
  const snap = await db().collection('whatsappProducts').doc(id).get();
  return snap.exists ? snap.data() : null;
}
// src by SRT X CHEATS. Copy right SRT X CHEATS

export async function deleteWhatsappProduct(id) {
  await db().collection('whatsappProducts').doc(id).delete();
  invalidateWhatsappProductCache();
}
// src by SRT X CHEATS. Copy right SRT X CHEATS


// src by SRT X CHEATS. Copy right SRT X CHEATS
// "Shop project" (store source code) products - own collection, own purchase flow (routes/shopsrc.js).
const shopSrcProducts = cachedLoader(async () => {
  const snap = await db().collection('shopSrcProducts').get();
  const map = {};
  snap.forEach((d) => { map[d.id] = d.data(); });
  return map;
}, { ttlMs: TTL.catalog, name: 'shopSrcProducts', versionKey: 'catalog' });

export function invalidateShopSrcProductCache() {
  shopSrcProducts.invalidate();
}

export async function getShopSrcProductRaw(id) {
  const snap = await db().collection('shopSrcProducts').doc(id).get();
  return snap.exists ? snap.data() : null;
}

export async function deleteShopSrcProduct(id) {
  await db().collection('shopSrcProducts').doc(id).delete();
  invalidateShopSrcProductCache();
}

export async function getLiveCatalog(role = 'user') {
  let base = { ...catalogForRole(role) };

  try {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    const custom = await refreshCustomProducts();
    for (const [sku, p] of Object.entries(custom)) base[sku] = applyCustomRole(p, role);
  } catch (e) {
    console.error('[catalog] custom products unavailable, showing static catalog only:', e);
  }
// src by SRT X CHEATS. Copy right SRT X CHEATS

  try {
    const whatsapp = await refreshWhatsappProducts();
    for (const [id, p] of Object.entries(whatsapp)) {
      base[id] = { ...applyCustomRole(p, role), type: 'whatsapp', row: p.name, name: p.name };
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    }
  } catch (e) {
    console.error('[catalog] whatsapp products unavailable:', e);
  }

  try {
    const shop = await shopSrcProducts.get();
    for (const [id, p] of Object.entries(shop)) {
      base[id] = {
        ...applyCustomRole(p, role), type: 'shopsrc', row: p.name, name: p.name, pinned: true,
        features: Array.isArray(p.features) && p.features.length ? p.features : DEFAULT_FEATURES,
      };
    }
  } catch (e) {
    console.error('[catalog] shop-source products unavailable:', e);
  }

  // src by SRT X CHEATS. Copy right SRT X CHEATS
  let overrides;
  try {
    overrides = await getMaintenanceOverrides();
  } catch (e) {
    console.error('[catalog] maintenance override lookup failed — showing the catalog without overrides:', e);
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    return applyRatings(base);
  }
  if (Object.keys(overrides).length === 0) return applyRatings(base);

  const merged = { ...base };
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  for (const sku of Object.keys(overrides)) {
    if (!merged[sku]) continue;
    const o = overrides[sku];
    merged[sku] = {
      ...merged[sku],
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      maintenance: !!o.maintenance,
      maintenanceMessage: o.maintenance ? (o.maintenanceMessage || merged[sku].maintenanceMessage || 'This product is temporarily under maintenance.') : undefined,
      outOfStock: !!o.outOfStock,
      outOfStockMessage: o.outOfStock ? (o.outOfStockMessage || 'Out of stock — check back soon.') : undefined,
      ...(o.image !== undefined ? { image: o.image } : {}),
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      ...(o.name !== undefined ? { name: o.name } : {}),
      ...(o.duration !== undefined ? { duration: o.duration } : {}),
      ...(o.pid !== undefined ? { pid: o.pid } : {}),
      ...(o.price !== undefined ? { price: tierPrice(o, role) } : {}),
    };
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  }
  return applyRatings(merged);
}

async function applyRatings(catalogObj) {
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  let ratings;
  try {
    ratings = await getProductRatings();
  } catch (e) {
    console.error('[catalog] rating lookup failed, showing catalog without ratings:', e);
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    return catalogObj;
  }
  const out = { ...catalogObj };
  for (const sku of Object.keys(out)) {
    const r = ratings[out[sku].row];
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    out[sku] = { ...out[sku], rating: r ? r.rating : null, reviewCount: r ? r.reviewCount : 0 };
  }
  return out;
}

// src by SRT X CHEATS. Copy right SRT X CHEATS
export async function getMaintenanceForSku(sku) {
  const snap = await db().collection('productStatus').doc(sku).get();
  if (!snap.exists) return { maintenance: false, outOfStock: false };
  const d = snap.data();
  return {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    maintenance: !!d.maintenance,
    maintenanceMessage: d.maintenanceMessage || null,
    outOfStock: !!d.outOfStock,
    outOfStockMessage: d.outOfStockMessage || null,
  };
// src by SRT X CHEATS. Copy right SRT X CHEATS
}
