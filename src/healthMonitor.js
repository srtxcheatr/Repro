// src by SRT X CHEATS. Copy right SRT X CHEATS
// Website + backend health watcher -> health bot (TELEGRAM_HEALTH_BOT_TOKEN / TELEGRAM_HEALTH_CHAT_ID).
//   HEALTH_CHECK_URLS         comma separated URLs to ping (your website, the backend /health ...)
//   HEALTH_CHECK_INTERVAL_MS  default 300000 (5 min), minimum 60000
//   HEALTH_CHECK_FIRESTORE=1  also test that Firestore answers (1 tiny read per check)
// An alert is sent when something goes DOWN (2 failed checks in a row) and again when it is back UP.
import { db } from './firebase.js';
import { telegramNotify, esc } from './telegram.js';

const state = new Map();   // name -> { fails, down, since }

export async function probe(name, fn) {
  const s = state.get(name) || { fails: 0, down: false, since: 0 };
  let err = '';
  const t0 = Date.now();
  try { await fn(); } catch (e) { err = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout (15s)' : String(e?.message || e).slice(0, 200); }
  const ms = Date.now() - t0;
  if (err) {
    s.fails += 1;
    if (s.fails >= 2 && !s.down) {
      s.down = true; s.since = Date.now();
      telegramNotify(`🔴 <b>DOWN</b> — ${esc(name)}\n${esc(err)}`, 'health');
    }
  } else {
    if (s.down) telegramNotify(`🟢 <b>BACK UP</b> — ${esc(name)}\nDown for ${Math.max(1, Math.round((Date.now() - s.since) / 60000))} min · ${ms} ms`, 'health');
    s.fails = 0; s.down = false;
  }
  state.set(name, s);
}

async function pingUrl(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'follow', headers: { 'User-Agent': 'srtx-health-monitor' } });
  if (r.status >= 500) throw new Error(`HTTP ${r.status}`);
}

export function startHealthMonitor() {
  const urls = String(process.env.HEALTH_CHECK_URLS || '').split(',').map((x) => x.trim()).filter(Boolean);
  const firestore = process.env.HEALTH_CHECK_FIRESTORE === '1';
  telegramNotify(`🟢 <b>Backend started</b>\n${new Date().toISOString()}${urls.length ? `\nWatching ${urls.length} URL(s)` : ''}`, 'health');
  if (!urls.length && !firestore) return;
  const every = Math.max(60_000, Number(process.env.HEALTH_CHECK_INTERVAL_MS) || 300_000);
  const run = async () => {
    for (const u of urls) await probe(u, () => pingUrl(u));
    if (firestore) await probe('Firestore', async () => { await db().collection('config').doc('versions').get(); });
  };
  setTimeout(run, 20_000).unref?.();
  setInterval(run, every).unref?.();
}
