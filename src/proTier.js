// src/proTier.js — PRO RESELLER rules. Pure functions, no imports, so any
// route can use them inside a Firestore transaction.
//
// Three roles (users/{uid}.role):
//   'user'          retail prices
//   'reseller'      reseller prices
//   'pro_reseller'  lowest prices (catalog3.js / priceProReseller)
//
// Pro reseller life-cycle (users/{uid}.proReseller.status):
//   none -> pending   user submitted the form (Telegram message sent to admin)
//   pending -> approved   admin pressed Approved ✅   (role + prices do NOT change yet)
//   pending -> rejected   admin pressed CANCEL ❌     (user may apply again)
//   approved -> active    NEW top-ups made AFTER approval reach PRO_MIN_TOPUP
//                         -> role becomes 'pro_reseller', prices drop
// Balance the user already had before approval never counts: only deposits
// credited after approval are added to proReseller.depositSinceApproval.

export const PRO_MIN_TOPUP = Number(process.env.PRO_RESELLER_MIN_TOPUP) > 0 ? Number(process.env.PRO_RESELLER_MIN_TOPUP) : 1500;

export const ROLES = ['user', 'reseller', 'pro_reseller'];
export const ROLE_LABEL = { user: 'USER', reseller: 'RESELLER', pro_reseller: 'PRO RESELLER' };

/** reseller + pro_reseller share reseller-only features (API, community, panel link). */
export const isResellerTier = (role) => role === 'reseller' || role === 'pro_reseller';

/** "pro reseller", "Pro-Reseller", "pro", "pro_reseller" -> 'pro_reseller'; unknown -> null. */
export function normalizeRole(input) {
  const t = String(input || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (t === 'user' || t === 'u') return 'user';
  if (t === 'reseller' || t === 'r') return 'reseller';
  if (t === 'proreseller' || t === 'pro' || t === 'p') return 'pro_reseller';
  return null;
}

/**
 * A credited deposit of `amount` (balance is already `balanceAfter`).
 * Returns { fields, log, activated } to merge into the SAME transaction that
 * credits the balance. No-op unless the user is in the 'approved' state.
 */
export function depositUpdate(data, amount, balanceAfter, nowIso = new Date().toISOString()) {
  const pr = data && data.proReseller;
  const amt = Number(amount);
  if (!pr || pr.status !== 'approved' || !(amt > 0)) return { fields: {}, log: [], activated: false };

  const required = Number(pr.requiredDeposit) > 0 ? Number(pr.requiredDeposit) : PRO_MIN_TOPUP;
  const deposited = Number(pr.depositSinceApproval || 0) + amt;

  if (deposited >= required) {
    return {
      activated: true,
      fields: { role: 'pro_reseller', proReseller: { ...pr, status: 'active', depositSinceApproval: deposited, activatedAt: nowIso } },
      log: [{ delta: 0, note: `Pro Reseller ACTIVATED — new top-ups NRP ${deposited} (needed ${required})`, resultingBalance: balanceAfter, at: nowIso }],
    };
  }
  return { activated: false, fields: { proReseller: { ...pr, depositSinceApproval: deposited } }, log: [] };
}

/** Manual role change (admin panel / Telegram /mode). Keeps proReseller.status consistent with the role. */
export function roleChangeUpdate(data, role, by, nowIso = new Date().toISOString()) {
  const pr = (data && data.proReseller) || {};
  const fields = { role };
  if (role === 'pro_reseller') {
    fields.proReseller = { ...pr, status: 'active', activatedAt: nowIso, manual: true };
  } else if (['active', 'approved', 'pending'].includes(pr.status)) {
    fields.proReseller = { ...pr, status: 'none', revokedAt: nowIso };
  }
  const log = [{ delta: 0, note: `Role changed to "${role}" (by ${by})`, resultingBalance: Number((data && data.balance) || 0), at: nowIso }];
  return { fields, log };
}

/** What the browser needs to draw the Pro Reseller card (safe fields only). */
export function proPublicState(data) {
  const pr = (data && data.proReseller) || {};
  const status = pr.status || 'none';
  return {
    status,                                   // none | pending | approved | active | rejected
    required: Number(pr.requiredDeposit) > 0 ? Number(pr.requiredDeposit) : PRO_MIN_TOPUP,
    deposited: Number(pr.depositSinceApproval || 0),
    // changes whenever the status changes, so the browser can show each popup exactly once
    stamp: String(pr.activatedAt || pr.reviewedAt || pr.requestedAt || ''),
  };
}
