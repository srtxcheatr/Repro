// src by SRT X CHEATS. Copy right SRT X CHEATS
// One-off repair: makes totalKeysBought / totalSpent / starCb.keys (reward counter) match the real records.
//   keys  = purchaseHistory entries + API orders delivered
//   spent = purchaseHistory prices + API orders charged + Glory groups not refunded
//   starCb.keys = keys bought on/after STAR_CASHBACK_FROM (never lowered)
//
// Usage (needs FIREBASE_SERVICE_ACCOUNT_JSON in the environment):
//   node scripts/recount-stats.js --email you@example.com        (dry run - shows what would change)
//   node scripts/recount-stats.js --email you@example.com --apply
//   node scripts/recount-stats.js --all                          (dry run for everyone)
//   node scripts/recount-stats.js --all --apply
import admin from 'firebase-admin';
import { getFirebaseApp, db } from '../src/firebase.js';
import { STAR_CASHBACK_FROM } from '../src/rewards.js';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const APPLY = flag('--apply');
const round2 = (n) => Math.round(n * 100) / 100;

getFirebaseApp();

let docs = [];
if (flag('--all')) {
  docs = (await db().collection('users').get()).docs;
} else if (val('--uid')) {
  const s = await db().collection('users').doc(val('--uid')).get();
  docs = s.exists ? [s] : [];
} else if (val('--email')) {
  const email = String(val('--email')).trim();
  const q = await db().collection('users').where('email', '==', email).get();
  docs = q.docs;
  if (!docs.length) {
    const u = await admin.auth().getUserByEmail(email).catch(() => null);
    if (u) { const s = await db().collection('users').doc(u.uid).get(); if (s.exists) docs = [s]; }
  }
} else {
  console.error('Usage: node scripts/recount-stats.js (--email x | --uid x | --all) [--apply]');
  process.exit(1);
}
if (!docs.length) { console.error('No matching user found.'); process.exit(1); }

// Glory spend per uid (groups that were not refunded)
const gloryByUid = new Map();
const gsnap = await db().collection('gloryGroups').get();
gsnap.forEach((g) => {
  const d = g.data();
  if (!d.uid || d.status === 'refunded') return;
  gloryByUid.set(d.uid, (gloryByUid.get(d.uid) || 0) + (Number(d.price) || 0));
});

let changed = 0;
for (const doc of docs) {
  const d = doc.data();
  const history = Array.isArray(d.purchaseHistory) ? d.purchaseHistory : [];
  let keys = history.length;
  let spent = history.reduce((n, h) => n + (Number(h.price) || 0), 0);
  let newKeys = history.filter((h) => Date.parse(h.at) >= STAR_CASHBACK_FROM).length;

  const api = await doc.ref.collection('apiOrders').get();
  api.forEach((o) => {
    const x = o.data();
    if (x.status === 'processing') return;
    const delivered = Number(x.delivered || 0);
    keys += delivered;
    spent += Number(x.charged || 0);
    if (Number(x.createdAt || 0) >= STAR_CASHBACK_FROM) newKeys += delivered;
  });
  spent = round2(spent + (gloryByUid.get(doc.id) || 0));

  const curKeys = Number(d.totalKeysBought || 0);
  const curSpent = Number(d.totalSpent || 0);
  const curNew = Number(d.starCb?.keys || 0);
  const nextNew = Math.max(curNew, newKeys);

  if (curKeys === keys && curSpent === spent && curNew === nextNew) continue;
  changed++;
  console.log(`${doc.id} ${d.email || ''}\n  keys ${curKeys} -> ${keys} | spent ${curSpent} -> ${spent} | reward keys ${curNew} -> ${nextNew}`);
  if (APPLY) {
    await doc.ref.set({ totalKeysBought: keys, totalSpent: spent, starCb: { keys: nextNew } }, { merge: true });
  }
}
console.log(`\n${changed} account(s) ${APPLY ? 'UPDATED' : 'would change (dry run - add --apply to write)'}.`);
console.log('After applying, restart the backend (or wait ~5 min) so cached profiles refresh.');
process.exit(0);
