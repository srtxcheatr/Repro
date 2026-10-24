// src by SRT X CHEATS. Copy right SRT X CHEATS
export async function fetchRealKey(sku, product, androidId = null) {
  const API_KEY = process.env.RESELLER_API_KEY;
  const MASTER_KEY = process.env.RESELLER_MASTER_KEY;
  const API_URL = process.env.RESELLER_ENDPOINT || 'https://bantibhaiya.to/api/reseller_v1.php';
// src by SRT X CHEATS. Copy right SRT X CHEATS

  if (!API_KEY) throw new Error('RESELLER_API_KEY missing');
  if (!MASTER_KEY) throw new Error('RESELLER_MASTER_KEY missing');

  const duration = product.duration;
// src by SRT X CHEATS. Copy right SRT X CHEATS

  const formData = new URLSearchParams();
  formData.append('api_key', API_KEY);
  formData.append('action', 'buy');
  formData.append('product_id', product.pid);
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  formData.append('duration', duration);
  if (androidId) {
    formData.append('android_id', androidId);
  }

  // src by SRT X CHEATS. Copy right SRT X CHEATS
  console.log(`[Reseller] Request: POST ${API_URL} pid=${product.pid}, duration=${JSON.stringify(duration)}${androidId ? `, android_id=${androidId}` : ''}`);

  // Exactly what the provider's official PHP/cURL example sends: form body + x-master-key + a normal User-Agent.
  // (Browser-style Origin / Referer / Sec-Fetch-* headers were removed: they are not part of the official example and
  // make the provider's nginx treat a server-to-server call like a cross-site browser request.)
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'x-master-key': MASTER_KEY,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };

  let response;
  try {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    response = await fetch(API_URL, {
      method: 'POST',
      headers,
      body: formData.toString(),
      signal: AbortSignal.timeout(15000),
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      redirect: 'follow',
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Request timed out. Please try again.');
    throw new Error(`Connection failed: ${err.message}`);
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  }

  const text = await response.text();
  console.log('[Reseller] HTTP', response.status, `server=${response.headers.get('server') || '-'} cf-ray=${response.headers.get('cf-ray') || '-'}`, 'raw response (first 500 chars):', text.slice(0, 500));

  // Supplier server is down / URL moved / path removed: never show their HTML error page to users or in Telegram.
  const looksHtml = /^\s*(<!doctype|<html|<head|<body|<center|<\?xml)/i.test(text);
  if (response.status === 404 || response.status === 410) {
    console.error(`[Reseller] ENDPOINT NOT FOUND (HTTP ${response.status}) at ${API_URL} - check RESELLER_ENDPOINT / the supplier's current API URL`);
    throw new Error('Supplier server is temporarily unavailable (endpoint not found). Please try again later.');
  }
  if (response.status >= 500 || response.status === 502 || response.status === 503 || response.status === 504) {
    throw new Error(`Supplier server is temporarily unavailable (HTTP ${response.status}). Please try again later.`);
  }
  if (response.status === 429) throw new Error('Supplier is busy (too many requests). Please try again in a minute.');

  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (text.includes('Just a moment') || text.includes('challenges.cloudflare.com')) {
    throw new Error('The target reseller API is still blocking Cloudflare IPs. Contact their support or try a different Worker region.');
  }

  let data;
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  try {
    data = JSON.parse(text);
  } catch (_) {
    // plain-text key: only when the request succeeded, it is not HTML, and it is a single short token line
    if (response.ok && !looksHtml && text.trim().length > 0 && text.trim().length < 100 && !/[<>]/.test(text)) {
      return text.trim();
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    }
    console.error('[Reseller] Unreadable supplier response, HTTP', response.status, text.slice(0, 200));
    throw new Error(looksHtml || !response.ok
      ? 'Supplier server returned an unexpected page. Please try again later.'
      : 'Supplier returned an unreadable response. Please try again later.');
  }

  if (!response.ok) {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    const msg = String(data?.message || data?.error || `HTTP ${response.status}`).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150);
    throw new Error(`API error: ${msg}`);
  }

  if (data.success === false) {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    throw new Error(data.message || 'API reported failure');
  }

  const key = data.key || data.data?.key || data.result?.key || null;
  if (!key) {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    console.error('[Reseller] No key in response:', JSON.stringify(data));
    throw new Error('maintenance .or. out of stock');
  }

  console.log('[Reseller] Key fetched successfully');
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  return key;
}
