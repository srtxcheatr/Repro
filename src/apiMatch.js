// src by SRT X CHEATS. Copy right SRT X CHEATS
const UNITS = 'second|minute|min|hour|hr|day|week|month|year';

export function normDuration(input) {
  return String(input ?? '')
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    .toLowerCase()
    .replace(/[_\-+.]+/g, ' ')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(new RegExp(`\\b(${UNITS})s\\b`, 'g'), '$1')
    .replace(/\s+/g, ' ')
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    .trim();
}

export function apiLabel(product) {
  const custom = String(product?.apiDuration ?? '').trim();
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  return custom || String(product?.duration ?? '').trim();
}

export const API_DURATION_RE = /^[A-Za-z0-9 _.+\-]{1,40}$/;

// src by SRT X CHEATS. Copy right SRT X CHEATS
export function matchProduct(products, pid, durationInput) {
  const wantPid = String(pid ?? '').trim();
  const wantDur = normDuration(durationInput);
  if (!wantPid || !wantDur) return { error: 'NOT_FOUND' };

  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const samePid = products.filter((p) => String(p.pid ?? '').trim() === wantPid);

  let hits = samePid.filter((p) => normDuration(apiLabel(p)) === wantDur);
  if (hits.length === 0) hits = samePid.filter((p) => normDuration(p.duration) === wantDur);

  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (hits.length === 0) return { error: 'NOT_FOUND' };
  if (hits.length > 1) return { error: 'AMBIGUOUS', skus: hits.map((h) => h.sku) };
  return { product: hits[0] };
}

// src by SRT X CHEATS. Copy right SRT X CHEATS
export function findLabelConflict(products, pid, label, excludeSku = null) {
  const wantPid = String(pid ?? '').trim();
  const wantDur = normDuration(label);
  return products.find((p) =>
    p.sku !== excludeSku &&
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    String(p.pid ?? '').trim() === wantPid &&
    normDuration(apiLabel(p)) === wantDur
  ) || null;
}

// src by SRT X CHEATS. Copy right SRT X CHEATS
export function keyToString(key) {
  if (Array.isArray(key)) return key.join('');
  if (key === null || key === undefined) return '';
  return String(key).trim();
}
// src by SRT X CHEATS. Copy right SRT X CHEATS
