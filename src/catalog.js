// Firestore-only product catalog.
// Product documents live in Firestore collection: products/{sku}.
// catalog1.js/catalog2.js are intentionally no longer imported.
// Expected product fields:
// { row, name, image, duration, pid, price, priceReseller, tags: [],
//   source: "fps"|"reseller"|"manual", free: boolean, maintenance, outOfStock }

import { db } from './firebase.js';

const CACHE_TTL = 15 * 1000;
let productCache = {};
let productCacheAt = 0;
let statusCache = {};
let statusCacheAt = 0;
let ratingCache = null;
let ratingCacheAt = 0;

function normalizeTags(tags) {
  const allowed = new Set(['iOS','NONROOT','ROOT','PC','FREE']);
  const arr = Array.isArray(tags) ? tags : String(tags || '').split(',');
  return [...new Set(arr.map(x => String(x).trim().toUpperCase())
    .filter(Boolean)
    .map(x => x === 'IOS' ? 'iOS' : x)
    .filter(x => allowed.has(x)))];
}

function withRole(p, role='user') {
  if (!p) return null;
  const reseller = role === 'reseller';
  return {
    ...p,
    tags: normalizeTags(p.tags),
    price: Number(reseller ? (p.priceReseller ?? p.price) : p.price) || 0,
    priceReseller: Number(p.priceReseller ?? p.price) || 0,
  };
}

async function refreshProducts(force=false) {
  const now = Date.now();
  if (!force && productCacheAt && now - productCacheAt < CACHE_TTL) return productCache;
  const snap = await db().collection('products').get();
  const map = {};
  snap.forEach(d => { map[d.id] = { sku: d.id, ...d.data(), tags: normalizeTags(d.data().tags) }; });
  productCache = map;
  productCacheAt = now;
  return map;
}

export function invalidateProductCache() {
  productCacheAt = 0;
}

export async function getProductRaw(sku) {
  if (!sku) return null;
  const snap = await db().collection('products').doc(sku).get();
  return snap.exists ? { sku: snap.id, ...snap.data(), tags: normalizeTags(snap.data().tags) } : null;
}

export async function findProductFresh(sku, role='user') {
  const p = await getProductRaw(sku);
  return p ? withRole(p, role) : null;
}

// Kept for compatibility with older route imports.
export async function findCustomProductFresh(sku, role='user') {
  return findProductFresh(sku, role);
}
export async function getCustomProductRaw(sku) { return getProductRaw(sku); }
export async function deleteCustomProduct(sku) {
  await db().collection('products').doc(sku).delete();
  invalidateProductCache();
}

export async function catalogFind(sku, role='user') {
  return findProductFresh(sku, role);
}

export function catalogForRole(role='user') {
  return Object.fromEntries(Object.entries(productCache).map(([sku,p]) => [sku, withRole(p, role)]));
}

export async function getMaintenanceOverrides() {
  const now = Date.now();
  if (statusCacheAt && now - statusCacheAt < CACHE_TTL) return statusCache;
  const snap = await db().collection('productStatus').get();
  const map = {};
  snap.forEach(d => map[d.id] = d.data());
  statusCache = map; statusCacheAt = now;
  return map;
}
export function invalidateMaintenanceCache() { statusCacheAt = 0; }

export async function getMaintenanceForSku(sku) {
  const snap = await db().collection('productStatus').doc(sku).get();
  if (!snap.exists) return { maintenance:false, outOfStock:false };
  const d = snap.data();
  return {
    maintenance: !!d.maintenance,
    maintenanceMessage: d.maintenanceMessage || null,
    outOfStock: !!d.outOfStock,
    outOfStockMessage: d.outOfStockMessage || null,
  };
}

async function getProductRatings() {
  const now = Date.now();
  if (ratingCache && now-ratingCacheAt < CACHE_TTL) return ratingCache;
  const snap = await db().collection('feedback').get();
  const sums = {};
  snap.forEach(d => {
    const f=d.data(); if (!f.row || !f.stars) return;
    if (!sums[f.row]) sums[f.row]={total:0,count:0};
    sums[f.row].total += Number(f.stars); sums[f.row].count++;
  });
  const out={};
  for (const [row,v] of Object.entries(sums))
    out[row]={rating:Math.round((v.total/v.count)*10)/10,reviewCount:v.count};
  ratingCache=out; ratingCacheAt=now; return out;
}
export function invalidateRatingCache(){ ratingCacheAt=0; }

function applyStatus(base,statuses) {
  const out={...base};
  for (const [sku,o] of Object.entries(statuses||{})) {
    if (!out[sku]) continue;
    out[sku]={
      ...out[sku],
      ...(o.image !== undefined ? {image:o.image}:{}),
      ...(o.name !== undefined ? {name:o.name}:{}),
      ...(o.duration !== undefined ? {duration:o.duration}:{}),
      ...(o.pid !== undefined ? {pid:o.pid}:{}),
      ...(o.row !== undefined ? {row:o.row}:{}),
      ...(o.tags !== undefined ? {tags:normalizeTags(o.tags)}:{}),
      ...(o.price !== undefined ? {price:Number(o.price)}:{}),
      ...(o.priceReseller !== undefined ? {priceReseller:Number(o.priceReseller)}:{}),
      maintenance:!!o.maintenance,
      maintenanceMessage:o.maintenance ? (o.maintenanceMessage || 'This product is temporarily under maintenance.') : undefined,
      outOfStock:!!o.outOfStock,
      outOfStockMessage:o.outOfStock ? (o.outOfStockMessage || 'Out of stock — check back soon.') : undefined,
    };
  }
  return out;
}

export async function getLiveCatalog(role='user') {
  const products = await refreshProducts();
  let base = {};
  for (const [sku,p] of Object.entries(products)) base[sku]=withRole(p,role);

  try { base=applyStatus(base, await getMaintenanceOverrides()); }
  catch(e){ console.error('[catalog] status lookup failed:',e.message); }

  try {
    const ratings=await getProductRatings();
    for (const sku of Object.keys(base)) {
      const r=ratings[base[sku].row];
      base[sku]={...base[sku],rating:r?.rating ?? null,reviewCount:r?.reviewCount ?? 0};
    }
  } catch(e){ console.error('[catalog] rating lookup failed:',e.message); }

  return base;
}

export async function upsertProduct(sku, data) {
  const clean={
    ...data,
    tags: normalizeTags(data.tags),
    updatedAt: Date.now(),
    createdAt: data.createdAt || Date.now(),
  };
  await db().collection('products').doc(sku).set(clean,{merge:true});
  invalidateProductCache();
  return {sku,...clean};
}
