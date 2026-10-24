// src by SRT X CHEATS. Copy right SRT X CHEATS
// Run on Render (Shell tab):  node scripts/test-upstream.js
// Harmless diagnostics only: never sends action=buy, so nothing is purchased. Keys are never printed.
const URL_ = process.env.RESELLER_ENDPOINT || 'https://bantibhaiya.to/api/reseller_v1.php';
const API_KEY = process.env.RESELLER_API_KEY || '';
const MASTER = process.env.RESELLER_MASTER_KEY || '';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const origin = new URL(URL_).origin;

async function hit(label, url, opts) {
  try {
    const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000), redirect: 'manual' });
    const t = (await r.text()).replace(/\s+/g, ' ').slice(0, 110);
    console.log(`${label}\n   -> HTTP ${r.status} server=${r.headers.get('server') || '-'} cf-ray=${r.headers.get('cf-ray') || '-'} location=${r.headers.get('location') || '-'}\n   -> ${t}`);
  } catch (e) { console.log(`${label}\n   -> FAILED: ${e.message}`); }
}

console.log('Endpoint :', URL_, '| api key set:', !!API_KEY, '| master key set:', !!MASTER);
try { console.log('This server\'s public IP (give it to the provider):', (await (await fetch('https://api.ipify.org')).text()).trim()); } catch { console.log('Could not read public IP'); }
console.log('');

const form = (extra = {}) => new URLSearchParams({ api_key: API_KEY, action: 'balance', ...extra }).toString();
const clean = { 'Content-Type': 'application/x-www-form-urlencoded', 'x-master-key': MASTER, 'User-Agent': UA };
const browserish = { ...clean, Origin: origin, Referer: origin + '/', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors' };

await hit('1) Site root (is the domain reachable from this server?)', origin + '/', { headers: { 'User-Agent': UA } });
await hit('2) Endpoint, plain GET', URL_, { headers: { 'User-Agent': UA } });
await hit('3) Endpoint, POST like the provider\'s PHP sample (clean headers)', URL_, { method: 'POST', headers: clean, body: form() });
await hit('4) Endpoint, POST with browser-style headers (OLD code)', URL_, { method: 'POST', headers: browserish, body: form() });
await hit('5) Endpoint, POST with curl User-Agent', URL_, { method: 'POST', headers: { ...clean, 'User-Agent': 'curl/8.5.0' }, body: form() });
console.log('\nHow to read it: a JSON answer (even an error like "invalid action") means the request reached their PHP = good.');
console.log('Same nginx 404 on every line, even the site root => this server IP is blocked: ask the provider to whitelist the IP printed above.');
