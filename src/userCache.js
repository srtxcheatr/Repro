// src by SRT X CHEATS. Copy right SRT X CHEATS
import { db } from './firebase.js';
import { cachedKeyedLoader, TTL } from './cache.js';
import { bumpUser, bumpAllUsers } from './versions.js';
import { markDirty, markAllDirty } from './adminDirectory.js';
// src by SRT X CHEATS. Copy right SRT X CHEATS

const users = cachedKeyedLoader(async (uid) => {
  const snap = await db().collection('users').doc(uid).get();
  return { exists: snap.exists, data: snap.exists ? snap.data() : null, at: Date.now() };
}, { ttlMs: TTL.userDoc, name: 'userDoc' });
// src by SRT X CHEATS. Copy right SRT X CHEATS

export function getUserDoc(uid) {
  return users.get(uid);
}

// src by SRT X CHEATS. Copy right SRT X CHEATS
export function invalidateUserDoc(uid, opts = {}) {
  users.invalidate(uid);
  bumpUser(uid, opts);
  markDirty(uid);
}
// src by SRT X CHEATS. Copy right SRT X CHEATS

export function invalidateAllUserDocs() {
  users.invalidateAll();
  bumpAllUsers();
  markAllDirty();
// src by SRT X CHEATS. Copy right SRT X CHEATS
}
