// src/upstream.js — the ONE place that talks to the real (upstream) reseller panel.
// Shared by the storefront checkout (routes/purchase.js) and the reseller API
// (routes/reseller-api.js) so both buy keys in exactly the same way.

// ============================================================
//  Fetch key from reseller API – reads from environment
// ============================================================
export async function fetchRealKey(sku, product, androidId = null) {
  const API_KEY = process.env.RESELLER_API_KEY;
  const MASTER_KEY = process.env.RESELLER_MASTER_KEY;
  const API_URL = process.env.RESELLER_ENDPOINT || 'https://bantibhaiya.to/api/reseller_v1.php';

  if (!API_KEY) throw new Error('RESELLER_API_KEY missing');
  if (!MASTER_KEY) throw new Error('RESELLER_MASTER_KEY missing');

  // ✅ CRITICAL FIX: Uses the exact text from your catalog (e.g. "1 DaYs", "1 Hours")
  const duration = product.duration;

  const formData = new URLSearchParams();
  formData.append('api_key', API_KEY);
  formData.append('action', 'buy');
  formData.append('product_id', product.pid);
  formData.append('duration', duration);
  if (androidId) {
    formData.append('android_id', androidId);
  }

  console.log(`[Reseller] Request: pid=${product.pid}, duration=${duration}${androidId ? `, android_id=${androidId}` : ''}`);

  // Referer/Origin must match whatever host RESELLER_ENDPOINT actually
  // points at — a stale hardcoded domain here can itself get the request
  // rejected (or flagged) by the reseller panel, independent of whether
  // the credentials are correct.
  const apiOrigin = new URL(API_URL).origin;
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'x-master-key': MASTER_KEY,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer': `${apiOrigin}/`,
    'Origin': apiOrigin,
    'Connection': 'keep-alive',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
  };

  let response;
  try {
    // Sending to API_URL (which now points to your Cloudflare Worker)
    response = await fetch(API_URL, {
      method: 'POST',
      headers,
      body: formData.toString(),
      signal: AbortSignal.timeout(15000),
      redirect: 'follow',
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Request timed out. Please try again.');
    throw new Error(`Connection failed: ${err.message}`);
  }

  const text = await response.text();
  console.log('[Reseller] Raw response (first 500 chars):', text.slice(0, 500));

  // ---- Detect Cloudflare challenge ----
  if (text.includes('Just a moment') || text.includes('challenges.cloudflare.com')) {
    throw new Error('The target reseller API is still blocking Cloudflare IPs. Contact their support or try a different Worker region.');
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    if (text.trim().length > 0 && text.trim().length < 100) {
      return text.trim();
    }
    throw new Error(`Invalid response: ${text.slice(0, 200)}`);
  }

  if (!response.ok) {
    const msg = data?.message || data?.error || `HTTP ${response.status}`;
    throw new Error(`API error: ${msg}`);
  }

  if (data.success === false) {
    throw new Error(data.message || 'API reported failure');
  }

  const key = data.key || data.data?.key || data.result?.key || null;
  if (!key) {
    console.error('[Reseller] No key in response:', JSON.stringify(data));
    throw new Error('maintenance .or. out of stock');
  }

  console.log('[Reseller] Key fetched successfully');
  return key;
}
