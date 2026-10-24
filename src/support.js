// src by SRT X CHEATS. Copy right SRT X CHEATS
import { db } from './firebase.js';
import { makeStore } from './supportStore.js';

export * from './supportStore.js';
export const store = makeStore(db);
