// src by SRT X CHEATS. Copy right SRT X CHEATS
const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function verifyTurnstile(req, res, next) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const token = req.body?.turnstileToken;

  if (!secret) {
    console.error('[turnstile] TURNSTILE_SECRET_KEY is not set — refusing the request instead of skipping verification.');
    return res.status(500).json({ success: false, error: 'Internal server error. Please try again.' });
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  }
  if (!token) {
    return res.status(400).json({ success: false, error: 'Verification check missing. Please refresh the page and try again.' });
  }

  // src by SRT X CHEATS. Copy right SRT X CHEATS
  try {
    const r = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, response: token, remoteip: req.ip }),
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    });
    const data = await r.json();
    if (!data.success) {
      console.warn('[turnstile] rejected:', data['error-codes'] || data);
      return res.status(403).json({ success: false, error: 'Verification failed. Please try again.' });
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    }
    next();
  } catch (e) {
    console.error('[turnstile] verify request failed:', e);
    return res.status(500).json({ success: false, error: 'Internal server error. Please try again.' });
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  }
}
