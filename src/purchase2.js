// Server-side FPS purchase bridge.
// The shared secret NEVER leaves the backend.
// Products with source:"fps" are issued by fpsapp.onrender.com.
const FPS_URL = String(process.env.FPS_APP_URL || 'https://fpsapp.onrender.com').replace(/\/+$/,'');
const FPS_SECRET = process.env.FPS_SHARED_SECRET || '';

export async function issueFpsKey({ sku, product, uid, email, androidId=null }) {
  if (!FPS_SECRET) throw new Error('FPS_SHARED_SECRET is not configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`${FPS_URL}/api/purchase-key`, {
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'Accept':'application/json',
        'X-FPS-SECRET': FPS_SECRET,
      },
      body: JSON.stringify({
        sku, pid:product.pid, duration:product.duration,
        uid, email, androidId:androidId || null,
      }),
      signal:controller.signal,
    });
    const text=await response.text();
    let data={}; try { data=text ? JSON.parse(text):{}; } catch { throw new Error('FPS server returned invalid JSON'); }
    if(!response.ok || data.success===false) throw new Error(data.error || `FPS server HTTP ${response.status}`);
    if(!data.key) throw new Error('FPS server did not return a key');
    return data.key;
  } catch(e) {
    if(e.name==='AbortError') throw new Error('FPS key server timeout');
    throw e;
  } finally { clearTimeout(timer); }
}
