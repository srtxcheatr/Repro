// In-memory Firestore (optimistic transactions) for tests
export function fakeDb() {
  const data = new Map(); const ver = new Map();
  const key = (c, id) => `${c}/${id}`;
  const snap = (k) => ({ exists: data.has(k), data: () => (data.has(k) ? structuredClone(data.get(k)) : undefined) });
  const docRef = (c, id) => ({
    _k: key(c, id),
    async get() { await Promise.resolve(); return snap(key(c, id)); },
    async set(v, o) { const k = key(c, id); data.set(k, o?.merge ? { ...(data.get(k) || {}), ...structuredClone(v) } : structuredClone(v)); ver.set(k, (ver.get(k) || 0) + 1); },
    async update(v) { const k = key(c, id); data.set(k, { ...data.get(k), ...structuredClone(v) }); ver.set(k, (ver.get(k) || 0) + 1); },
    async delete() { const k = key(c, id); data.delete(k); ver.set(k, (ver.get(k) || 0) + 1); },
  });
  return {
    _data: data,
    collection: (c) => ({ doc: (id) => docRef(c, id),
      where: (f, _o, v) => ({ orderBy: () => ({ limit: () => ({ get: async () => ({ docs: [...data].filter(([k, d]) => k.startsWith(c + '/') && d[f] === v).map(([, d]) => ({ data: () => d })) }) }) }) }) }),
    async runTransaction(fn) {
      for (let i = 0; i < 25; i++) {
        const seen = new Map(); const writes = [];
        const tx = {
          async get(ref) { await new Promise((r) => setTimeout(r, Math.random() * 3)); seen.set(ref._k, ver.get(ref._k) || 0); return snap(ref._k); },
          set: (ref, v) => writes.push(() => ref.set(v)), update: (ref, v) => writes.push(() => ref.update(v)), delete: (ref) => writes.push(() => ref.delete()),
        };
        const out = await fn(tx);
        if ([...seen].every(([k, v]) => (ver.get(k) || 0) === v)) { for (const w of writes) await w(); return out; }   // commit only if nothing we read changed
      }
      throw new Error('tx contention');
    },
  };
}

