// src by SRT X CHEATS. Copy right SRT X CHEATS
const MAX_BASE64_CHARS = 1_500_000;

function httpError(status, message) {
  const e = new Error(message);
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  e.status = status;
  return e;
}

function normalizeImage(input, maxChars = MAX_BASE64_CHARS) {
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const raw = String(input || '').trim();
  if (!raw) throw httpError(400, 'No image received.');

  const m = raw.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/i);
  const b64 = (m ? m[2] : raw).replace(/\s+/g, '');
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (!/^[A-Za-z0-9+/=]+$/.test(b64)) throw httpError(400, 'Image data is not valid base64.');
  if (b64.length > maxChars) throw httpError(413, 'Image is too large. Pick a smaller size.');

  const head = Buffer.from(b64.slice(0, 24), 'base64');
  const isPng = head.length >= 4 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const isJpg = head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  const isWebp = head.length >= 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP';
  if (!isPng && !isJpg && !isWebp) throw httpError(400, 'Only PNG, JPG or WebP images are allowed.');
  return b64;
}
// src by SRT X CHEATS. Copy right SRT X CHEATS

export async function uploadImage(imageInput, namePrefix, { maxChars } = {}) {
  const key = process.env.IMGBB_API_KEY;
  if (!key) throw httpError(500, 'Image upload is not configured (IMGBB_API_KEY missing on the server).');
  const endpoint = process.env.IMGBB_ENDPOINT || 'https://api.imgbb.com/1/upload';
// src by SRT X CHEATS. Copy right SRT X CHEATS

  const image = normalizeImage(imageInput, maxChars || MAX_BASE64_CHARS);

  const body = new URLSearchParams();
  body.set('key', key);
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  body.set('image', image);
  body.set('name', `${namePrefix}_${Date.now()}`);

  let res;
  try {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
      signal: AbortSignal.timeout(20_000),
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    });
  } catch (e) {
    throw httpError(504, e?.name === 'TimeoutError' ? 'Image host timed out. Please try again.' : 'Could not reach the image host. Please try again.');
  }

  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }

  if (!res.ok || !json || json.success === false) {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    const reason = json?.error?.message || json?.status_txt || `HTTP ${res.status}`;
    console.error('[imgbb] upload failed:', res.status, String(reason).slice(0, 200));
    throw httpError(502, 'Image upload failed. Please try a different image or try again later.');
  }

  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const url = json?.data?.display_url || json?.data?.url;
  if (!url || !/^https:\/\//i.test(url)) {
    console.error('[imgbb] no usable URL in response');
    throw httpError(502, 'Image host returned an unexpected response.');
  }
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  return url;
}

export const uploadAvatar = (imageInput, uid) => uploadImage(imageInput, `avatar_${String(uid).slice(0, 12)}`);
