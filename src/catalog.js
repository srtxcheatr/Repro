// Firestore-only product catalog.
// Product documents live in Firestore collection: products/{sku}.
// catalog1.js/catalog2.js are intentionally no longer imported.
//
// Expected product fields:
// { row, name, image, duration, pid, price, priceReseller, tags: [],
//   source: "fps"|"reseller"|"manual", free: boolean, maintenance, outOfStock }

import { db } from './firebase.js';

const CACHE_TTL = 15 * 1000;
const WHATSAPP_CACHE_TTL = 30 * 1000;

let productCache = {};
let productCacheAt = 0;

let statusCache = {};
let statusCacheAt = 0;

let ratingCache = null;
let ratingCacheAt = 0;

let whatsappProductCache = {};
let whatsappProductCacheAt = 0;

function normalizeTags(tags) {
  const allowed = new Set(['iOS', 'NONROOT', 'ROOT', 'PC', 'FREE']);

  const arr = Array.isArray(tags)
    ? tags
    : String(tags || '').split(',');

  return [
    ...new Set(
      arr
        .map(x => String(x).trim().toUpperCase())
        .filter(Boolean)
        .map(x => x === 'IOS' ? 'iOS' : x)
        .filter(x => allowed.has(x))
    )
  ];
}

function withRole(p, role = 'user') {
  if (!p) return null;

  const reseller = role === 'reseller';

  return {
    ...p,
    tags: normalizeTags(p.tags),

    price: Number(
      reseller
        ? (p.priceReseller ?? p.price)
        : p.price
    ) || 0,

    priceReseller:
      Number(p.priceReseller ?? p.price) || 0,
  };
}

/* =========================================================
   NORMAL PRODUCTS
   ========================================================= */

async function refreshProducts(force = false) {
  const now = Date.now();

  if (
    !force &&
    productCacheAt &&
    now - productCacheAt < CACHE_TTL
  ) {
    return productCache;
  }

  const snap = await db()
    .collection('products')
    .get();

  const map = {};

  snap.forEach(doc => {
    const data = doc.data();

    map[doc.id] = {
      sku: doc.id,
      ...data,
      tags: normalizeTags(data.tags),
    };
  });

  productCache = map;
  productCacheAt = now;

  return map;
}

export function invalidateProductCache() {
  productCacheAt = 0;
}

export async function getProductRaw(sku) {
  if (!sku) return null;

  const snap = await db()
    .collection('products')
    .doc(sku)
    .get();

  if (!snap.exists) return null;

  const data = snap.data();

  return {
    sku: snap.id,
    ...data,
    tags: normalizeTags(data.tags),
  };
}

export async function findProductFresh(sku, role = 'user') {
  const product = await getProductRaw(sku);

  return product
    ? withRole(product, role)
    : null;
}

// Compatibility with older routes.
export async function findCustomProductFresh(
  sku,
  role = 'user'
) {
  return findProductFresh(sku, role);
}

export async function getCustomProductRaw(sku) {
  return getProductRaw(sku);
}

export async function deleteCustomProduct(sku) {
  if (!sku) {
    throw new Error('Product SKU is required');
  }

  await db()
    .collection('products')
    .doc(sku)
    .delete();

  invalidateProductCache();
}

export async function catalogFind(
  sku,
  role = 'user'
) {
  return findProductFresh(sku, role);
}

export function catalogForRole(role = 'user') {
  return Object.fromEntries(
    Object.entries(productCache).map(
      ([sku, product]) => [
        sku,
        withRole(product, role),
      ]
    )
  );
}

/* =========================================================
   MAINTENANCE / STOCK STATUS
   ========================================================= */

export async function getMaintenanceOverrides() {
  const now = Date.now();

  if (
    statusCacheAt &&
    now - statusCacheAt < CACHE_TTL
  ) {
    return statusCache;
  }

  const snap = await db()
    .collection('productStatus')
    .get();

  const map = {};

  snap.forEach(doc => {
    map[doc.id] = doc.data();
  });

  statusCache = map;
  statusCacheAt = now;

  return map;
}

export function invalidateMaintenanceCache() {
  statusCacheAt = 0;
}

export async function getMaintenanceForSku(sku) {
  if (!sku) {
    return {
      maintenance: false,
      outOfStock: false,
    };
  }

  const snap = await db()
    .collection('productStatus')
    .doc(sku)
    .get();

  if (!snap.exists) {
    return {
      maintenance: false,
      outOfStock: false,
    };
  }

  const data = snap.data();

  return {
    maintenance: !!data.maintenance,

    maintenanceMessage:
      data.maintenanceMessage || null,

    outOfStock: !!data.outOfStock,

    outOfStockMessage:
      data.outOfStockMessage || null,
  };
}

/* =========================================================
   RATINGS
   ========================================================= */

async function getProductRatings() {
  const now = Date.now();

  if (
    ratingCache &&
    now - ratingCacheAt < CACHE_TTL
  ) {
    return ratingCache;
  }

  const snap = await db()
    .collection('feedback')
    .get();

  const sums = {};

  snap.forEach(doc => {
    const feedback = doc.data();

    if (!feedback.row || !feedback.stars) {
      return;
    }

    if (!sums[feedback.row]) {
      sums[feedback.row] = {
        total: 0,
        count: 0,
      };
    }

    sums[feedback.row].total +=
      Number(feedback.stars);

    sums[feedback.row].count++;
  });

  const output = {};

  for (const [row, value] of Object.entries(sums)) {
    output[row] = {
      rating:
        Math.round(
          (value.total / value.count) * 10
        ) / 10,

      reviewCount: value.count,
    };
  }

  ratingCache = output;
  ratingCacheAt = now;

  return output;
}

export function invalidateRatingCache() {
  ratingCacheAt = 0;
}

/* =========================================================
   APPLY PRODUCT STATUS
   ========================================================= */

function applyStatus(base, statuses) {
  const output = {
    ...base,
  };

  for (
    const [sku, status] of Object.entries(
      statuses || {}
    )
  ) {
    if (!output[sku]) continue;

    output[sku] = {
      ...output[sku],

      ...(status.image !== undefined
        ? { image: status.image }
        : {}),

      ...(status.name !== undefined
        ? { name: status.name }
        : {}),

      ...(status.duration !== undefined
        ? { duration: status.duration }
        : {}),

      ...(status.pid !== undefined
        ? { pid: status.pid }
        : {}),

      ...(status.row !== undefined
        ? { row: status.row }
        : {}),

      ...(status.tags !== undefined
        ? { tags: normalizeTags(status.tags) }
        : {}),

      ...(status.price !== undefined
        ? { price: Number(status.price) }
        : {}),

      ...(status.priceReseller !== undefined
        ? {
            priceReseller:
              Number(status.priceReseller),
          }
        : {}),

      maintenance: !!status.maintenance,

      maintenanceMessage:
        status.maintenance
          ? (
              status.maintenanceMessage ||
              'This product is temporarily under maintenance.'
            )
          : undefined,

      outOfStock: !!status.outOfStock,

      outOfStockMessage:
        status.outOfStock
          ? (
              status.outOfStockMessage ||
              'Out of stock — check back soon.'
            )
          : undefined,
    };
  }

  return output;
}

/* =========================================================
   LIVE CATALOG
   ========================================================= */

export async function getLiveCatalog(
  role = 'user'
) {
  const products = await refreshProducts();

  let base = {};

  for (
    const [sku, product] of Object.entries(products)
  ) {
    base[sku] = withRole(product, role);
  }

  try {
    base = applyStatus(
      base,
      await getMaintenanceOverrides()
    );
  } catch (error) {
    console.error(
      '[catalog] status lookup failed:',
      error.message
    );
  }

  try {
    const ratings =
      await getProductRatings();

    for (const sku of Object.keys(base)) {
      const rating =
        ratings[base[sku].row];

      base[sku] = {
        ...base[sku],

        rating:
          rating?.rating ?? null,

        reviewCount:
          rating?.reviewCount ?? 0,
      };
    }
  } catch (error) {
    console.error(
      '[catalog] rating lookup failed:',
      error.message
    );
  }

  return base;
}

/* =========================================================
   CREATE / UPDATE PRODUCT
   ========================================================= */

export async function upsertProduct(
  sku,
  data
) {
  if (!sku) {
    throw new Error('Product SKU is required');
  }

  const clean = {
    ...data,

    tags: normalizeTags(data.tags),

    updatedAt: Date.now(),

    createdAt:
      data.createdAt || Date.now(),
  };

  await db()
    .collection('products')
    .doc(sku)
    .set(clean, {
      merge: true,
    });

  invalidateProductCache();

  return {
    sku,
    ...clean,
  };
}

/* =========================================================
   WHATSAPP PRODUCTS
   =========================================================
   
   Collection:
   whatsappProducts/{id}

   These products are separate from the normal
   products/{sku} catalog because they redirect
   customers to WhatsApp instead of automated checkout.
   ========================================================= */

async function refreshWhatsappProducts(
  force = false
) {
  const now = Date.now();

  if (
    !force &&
    whatsappProductCacheAt &&
    now - whatsappProductCacheAt <
      WHATSAPP_CACHE_TTL
  ) {
    return whatsappProductCache;
  }

  const snap = await db()
    .collection('whatsappProducts')
    .get();

  const map = {};

  snap.forEach(doc => {
    map[doc.id] = {
      id: doc.id,
      ...doc.data(),
    };
  });

  whatsappProductCache = map;
  whatsappProductCacheAt = now;

  return map;
}

export function invalidateWhatsappProductCache() {
  whatsappProductCacheAt = 0;
}

export async function getWhatsappProductRaw(
  id
) {
  if (!id) return null;

  const snap = await db()
    .collection('whatsappProducts')
    .doc(id)
    .get();

  if (!snap.exists) {
    return null;
  }

  return {
    id: snap.id,
    ...snap.data(),
  };
}

export async function deleteWhatsappProduct(
  id
) {
  if (!id) {
    throw new Error(
      'WhatsApp product ID is required'
    );
  }

  await db()
    .collection('whatsappProducts')
    .doc(id)
    .delete();

  invalidateWhatsappProductCache();
}

/* =========================================================
   OPTIONAL WHATSAPP CATALOG HELPER
   ========================================================= */

export async function getWhatsappProducts(
  role = 'user'
) {
  const products =
    await refreshWhatsappProducts();

  const reseller = role === 'reseller';

  return Object.values(products).map(
    product => ({
      ...product,

      price: Number(
        reseller
          ? (
              product.priceReseller ??
              product.price
            )
          : product.price
      ) || 0,

      priceReseller:
        Number(
          product.priceReseller ??
          product.price
        ) || 0,
    })
  );
}