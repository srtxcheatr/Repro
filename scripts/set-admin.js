// src by SRT X CHEATS. Copy right SRT X CHEATS
import { getFirebaseApp, db } from '../src/firebase.js';
import admin from 'firebase-admin';

const email = process.argv[2];
// src by SRT X CHEATS. Copy right SRT X CHEATS
const revoke = process.argv.includes('--revoke');

if (!email) {
  console.error('Usage: node scripts/set-admin.js you@example.com [--revoke]');
  process.exit(1);
// src by SRT X CHEATS. Copy right SRT X CHEATS
}

getFirebaseApp();

const user = await admin.auth().getUserByEmail(email).catch(() => null);
// src by SRT X CHEATS. Copy right SRT X CHEATS
if (!user) {
  console.error(`No account exists for ${email} yet. Register on the site with this email first (login page — email/password or Google both work), then run this again.`);
  process.exit(1);
}

// src by SRT X CHEATS. Copy right SRT X CHEATS
await db().collection('users').doc(user.uid).set({ isAdmin: !revoke }, { merge: true });
console.log(`${revoke ? 'Revoked' : 'Granted'} admin access for ${email} (uid: ${user.uid})`);
process.exit(0);
