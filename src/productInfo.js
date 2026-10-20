// Product lookup for the private bot (/product_info).
// "PHANTOM" finds "PHANTOM X TROLL MODZ" and every other product whose name contains it,
// and lists every duration with the User / Reseller / Pro Reseller price.
import { getLiveCatalog } from './srt_storage_product.js';
import { esc } from './telegram.js';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// "product - PHANTOM X", "product: phantom" and plain "phantom" all mean the same thing.
export function cleanQuery(q) {
  return String(q || '').replace(/^\s*product\s*[-:–—=]*\s*/i, '').trim();
}

export function matches(query, ...names) {
  const tokens = norm(query).split(' ').filter(Boolean);
  if (!tokens.length) return false;
  const hay = norm(names.join(' '));
  return tokens.every((t) => hay.includes(t));
}

// catalogs = { user, reseller, pro_reseller } (sku -> product). Returns groups sorted by name.
export function groupProducts(query, catalogs) {
  const groups = new Map();
  for (const [sku, p] of Object.entries(catalogs.user || {})) {
    const title = String(p.row || p.name || sku).trim();
    if (!matches(query, title, p.name)) continue;
    if (!groups.has(title)) groups.set(title, { title, items: [] });
    groups.get(title).items.push({
      sku, label: String(p.duration || p.name || '').trim(), whatsapp: p.type === 'whatsapp',
      user: p.price, reseller: catalogs.reseller?.[sku]?.price ?? p.price, pro: catalogs.pro_reseller?.[sku]?.price ?? catalogs.reseller?.[sku]?.price ?? p.price,
      maintenance: !!p.maintenance, outOfStock: !!p.outOfStock,
    });
  }
  const out = [...groups.values()].sort((a, b) => a.title.localeCompare(b.title));
  for (const g of out) g.items.sort((a, b) => Number(a.user) - Number(b.user));
  return out;
}

export async function searchProducts(query) {
  const [user, reseller, pro_reseller] = await Promise.all([getLiveCatalog('user'), getLiveCatalog('reseller'), getLiveCatalog('pro_reseller')]);
  return groupProducts(query, { user, reseller, pro_reseller });
}

const n = (x) => Number(x || 0).toLocaleString('en-US');

export function formatGroups(groups) {
  return groups.map((g) => {
    const lines = [`📦 <b>${esc(g.title)}</b>`];
    for (const i of g.items) {
      const flag = i.maintenance ? ' 🛠 maintenance' : i.outOfStock ? ' ❌ out of stock' : '';
      lines.push(i.whatsapp
        ? `  • ${esc(i.label)} (WhatsApp order) — User ${n(i.user)} · Reseller ${n(i.reseller)} · Pro ${n(i.pro)}${flag}`
        : `  • <b>${esc(i.label)}</b> — User <b>${n(i.user)}</b> · Reseller <b>${n(i.reseller)}</b> · Pro <b>${n(i.pro)}</b>${flag}`);
    }
    return lines.join('\n');
  });
}
