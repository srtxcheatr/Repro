// scripts/set-admin.js — grants (or revokes) admin-panel access for a
// Firebase account by email. This is how you become the first admin —
// there's no other way in since the panel itself requires isAdmin
// already be true.
//
// Run this locally, not on Render — it's a one-off, not part of the
// running server. Needs the SAME FIREBASE_SERVICE_ACCOUNT_JSON value
// you already have set on Render.
//
// Usage:
//   FIREBASE_SERVICE_ACCOUNT_JSON='<paste the whole JSON>' node scripts/set-admin.js you@example.com
//   FIREBASE_SERVICE_ACCOUNT_JSON='<paste the whole JSON>' node scripts/set-admin.js you@example.com --revoke
//
// The account must already exist (register on the site first with
// this email — email/password or Google both work) before running this.

import { getFirebaseApp, db } from '../src/firebase.js';
import admin from 'firebase-admin';

const email = process.argv[2];
const revoke = process.argv.includes('--revoke');

if (!email) {
  console.error('Usage: node scripts/set-admin.js you@example.com [--revoke]');
  process.exit(1);
}

getFirebaseApp();

const user = await admin.auth().getUserByEmail(email).catch(() => null);
if (!user) {
  console.error(`No account exists for ${email} yet. Register on the site with this email first (login page — email/password or Google both work), then run this again.`);
  process.exit(1);
}

await db().collection('users').doc(user.uid).set({ isAdmin: !revoke }, { merge: true });
console.log(`${revoke ? 'Revoked' : 'Granted'} admin access for ${email} (uid: ${user.uid})`);
process.exit(0);
