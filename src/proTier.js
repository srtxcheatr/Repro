// src by SRT X CHEATS. Copy right SRT X CHEATS
// Unlock rules (checked on every deposit, per SINGLE deposit — small top-ups of 100/200 are never added together):
//   RESELLER      = one deposit of NRP 2000 or more
//   PRO RESELLER  = 10+ keys bought AND one NEW deposit of NRP 3500 or more
const envNum = (v, d) => (Number(v) > 0 ? Number(v) : d);
export const RESELLER_MIN_DEPOSIT = envNum(process.env.RESELLER_MIN_DEPOSIT, 2000);
export const PRO_MIN_DEPOSIT = envNum(process.env.PRO_RESELLER_MIN_DEPOSIT, 3500);
export const PRO_MIN_KEYS = envNum(process.env.PRO_RESELLER_MIN_KEYS, 10);

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
  const none = { fields: {}, log: [], activated: false, resellerActivated: false };
  const amt = Number(amount);
  if (!(amt > 0)) return none;
  const role = (data && data.role) || 'user';
  if (role === 'pro_reseller') return none;
  const keys = Number((data && data.totalKeysBought) || 0);
// src by SRT X CHEATS. Copy right SRT X CHEATS

  // PRO RESELLER: 10+ keys AND this one deposit is NRP 3500+ (a user or a reseller can jump straight to it)
  if (amt >= PRO_MIN_DEPOSIT && keys >= PRO_MIN_KEYS) {
    const pr = (data && data.proReseller) || {};
    return {
      activated: true, resellerActivated: false,
      fields: { role: 'pro_reseller', proReseller: { ...pr, status: 'active', activatedAt: nowIso, depositSinceApproval: amt, requiredDeposit: PRO_MIN_DEPOSIT, manual: false } },
      log: [{ delta: 0, note: `Pro Reseller UNLOCKED — single deposit NRP ${amt} (needed ${PRO_MIN_DEPOSIT}) + ${keys} keys (needed ${PRO_MIN_KEYS})`, resultingBalance: balanceAfter, at: nowIso }],
    };
  }
  // RESELLER: one deposit of NRP 2000+ (plain users only)
  if (role === 'user' && amt >= RESELLER_MIN_DEPOSIT) {
    return {
      activated: false, resellerActivated: true,
      fields: { role: 'reseller' },
      log: [{ delta: 0, note: `Reseller UNLOCKED — single deposit NRP ${amt} (needed ${RESELLER_MIN_DEPOSIT})`, resultingBalance: balanceAfter, at: nowIso }],
    };
  }
  return none;
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
  const role = (data && data.role) || 'user';
  return {
    status: role === 'pro_reseller' ? 'active' : 'none',
    required: PRO_MIN_DEPOSIT,
    deposited: Number(pr.depositSinceApproval || 0),
    keys: Number((data && data.totalKeysBought) || 0),
    minKeys: PRO_MIN_KEYS,
    resellerRequired: RESELLER_MIN_DEPOSIT,
    stamp: String(pr.activatedAt || ''),
  };
}
