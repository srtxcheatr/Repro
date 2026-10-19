// src by SRT X CHEATS. Copy right SRT X CHEATS
export const PRO_MIN_TOPUP = Number(process.env.PRO_RESELLER_MIN_TOPUP) > 0 ? Number(process.env.PRO_RESELLER_MIN_TOPUP) : 1500;

export const ROLES = ['user', 'reseller', 'pro_reseller'];
export const ROLE_LABEL = { user: 'USER', reseller: 'RESELLER', pro_reseller: 'PRO RESELLER' };
// src by SRT X CHEATS. Copy right SRT X CHEATS

export const isResellerTier = (role) => role === 'reseller' || role === 'pro_reseller';

export function normalizeRole(input) {
  const t = String(input || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (t === 'user' || t === 'u') return 'user';
  if (t === 'reseller' || t === 'r') return 'reseller';
  if (t === 'proreseller' || t === 'pro' || t === 'p') return 'pro_reseller';
  return null;
}
// src by SRT X CHEATS. Copy right SRT X CHEATS

export function depositUpdate(data, amount, balanceAfter, nowIso = new Date().toISOString()) {
  const pr = data && data.proReseller;
  const amt = Number(amount);
  if (!pr || pr.status !== 'approved' || !(amt > 0)) return { fields: {}, log: [], activated: false };
// src by SRT X CHEATS. Copy right SRT X CHEATS

  const required = Number(pr.requiredDeposit) > 0 ? Number(pr.requiredDeposit) : PRO_MIN_TOPUP;
  const deposited = Number(pr.depositSinceApproval || 0) + amt;

  if (deposited >= required) {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    return {
      activated: true,
      fields: { role: 'pro_reseller', proReseller: { ...pr, status: 'active', depositSinceApproval: deposited, activatedAt: nowIso } },
      log: [{ delta: 0, note: `Pro Reseller ACTIVATED — new top-ups NRP ${deposited} (needed ${required})`, resultingBalance: balanceAfter, at: nowIso }],
    };
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  }
  return { activated: false, fields: { proReseller: { ...pr, depositSinceApproval: deposited } }, log: [] };
}

export function roleChangeUpdate(data, role, by, nowIso = new Date().toISOString()) {
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const pr = (data && data.proReseller) || {};
  const fields = { role };
  if (role === 'pro_reseller') {
    fields.proReseller = { ...pr, status: 'active', activatedAt: nowIso, manual: true };
  } else if (['active', 'approved', 'pending'].includes(pr.status)) {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    fields.proReseller = { ...pr, status: 'none', revokedAt: nowIso };
  }
  const log = [{ delta: 0, note: `Role changed to "${role}" (by ${by})`, resultingBalance: Number((data && data.balance) || 0), at: nowIso }];
  return { fields, log };
}
// src by SRT X CHEATS. Copy right SRT X CHEATS

export function proPublicState(data) {
  const pr = (data && data.proReseller) || {};
  const status = pr.status || 'none';
  return {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    status,
    required: Number(pr.requiredDeposit) > 0 ? Number(pr.requiredDeposit) : PRO_MIN_TOPUP,
    deposited: Number(pr.depositSinceApproval || 0),
    stamp: String(pr.activatedAt || pr.reviewedAt || pr.requestedAt || ''),
  };
// src by SRT X CHEATS. Copy right SRT X CHEATS
}
