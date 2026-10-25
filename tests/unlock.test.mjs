import assert from 'node:assert/strict';
import { depositUpdate } from '../src/proTier.js';

const U = (o = {}) => ({ role: 'user', totalKeysBought: 0, ...o });
// small top-ups never add up
assert.equal(depositUpdate(U(), 100, 100).fields.role, undefined);
assert.equal(depositUpdate(U({ balance: 1900 }), 200, 2100).fields.role, undefined);
assert.equal(depositUpdate(U(), 1999, 1999).fields.role, undefined);
// reseller = one deposit of 2000+
let r = depositUpdate(U(), 2000, 2000);
assert.equal(r.fields.role, 'reseller'); assert.equal(r.resellerActivated, true); assert.equal(r.activated, false);
// 3500 without 10 keys -> reseller only
r = depositUpdate(U({ totalKeysBought: 9 }), 3500, 3500);
assert.equal(r.fields.role, 'reseller'); assert.equal(r.activated, false);
// pro = 10+ keys AND one 3500+ deposit
r = depositUpdate(U({ role: 'reseller', totalKeysBought: 10 }), 3500, 3500);
assert.equal(r.fields.role, 'pro_reseller'); assert.equal(r.activated, true);
assert.equal(r.fields.proReseller.depositSinceApproval, 3500);
r = depositUpdate(U({ totalKeysBought: 25 }), 5000, 5000);
assert.equal(r.fields.role, 'pro_reseller');
// 3499 / 10 keys is not enough; two 2000s are not 3500
assert.equal(depositUpdate(U({ role: 'reseller', totalKeysBought: 50 }), 3499, 1).fields.role, undefined);
assert.equal(depositUpdate(U({ role: 'reseller', totalKeysBought: 50 }), 2000, 1).fields.role, undefined);
// existing pro untouched; reseller doesn't re-unlock
assert.deepEqual(depositUpdate(U({ role: 'pro_reseller', totalKeysBought: 99 }), 9999, 1).fields, {});
assert.equal(depositUpdate(U({ role: 'reseller' }), 2500, 1).resellerActivated, false);
console.log('ok   reseller / pro reseller unlock rules');
