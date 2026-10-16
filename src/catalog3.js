// CATALOG 3 -> role "pro_reseller" (lowest price tier).
// Same shape as catalog2.js. Any sku NOT listed here automatically falls back
// to the reseller price (catalog2.js), then to retail (catalog1.js), so this
// file can stay empty or partial. Custom products added from the admin panel
// use their own "priceProReseller" field instead (falls back to priceReseller).
export const CATALOG_PRO = {

};
