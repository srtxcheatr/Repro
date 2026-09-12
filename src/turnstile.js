// src/turnstile.js — Cloudflare Turnstile verification.
//
// Confirms the token the frontend widget produced is real before an
// endpoint does any actual work (sending an email, touching
// Firestore). Fails CLOSED: if the secret isn't configured, or
// Cloudflare's own verify call errors out, the request is rejected
// rather than let through — a broken check should never become an
// open door.
//
// IMPORTANT SCOPE NOTE: this only protects requests that pass through
// THIS backend. It has no effect on calls straight to Google's
// identitytoolkit.googleapis.com (login/signup in login.php), since
// those never touch this server at all — see README.md for what
// actually covers that path.

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function verifyTurnstile(req, res, next) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  const token = req.body?.turnstileToken;

  if (!secret) {
    console.error('[turnstile] TURNSTILE_SECRET_KEY is not set — refusing the request instead of skipping verification.');
    return res.status(500).json({ success: false, error: 'Internal server error. Please try again.' });
  }
  if (!token) {
    return res.status(400).json({ success: false, error: 'Verification check missing. Please refresh the page and try again.' });
  }

  try {
    const r = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, response: token, remoteip: req.ip }),
    });
    const data = await r.json();
    if (!data.success) {
      console.warn('[turnstile] rejected:', data['error-codes'] || data);
      return res.status(403).json({ success: false, error: 'Verification failed. Please try again.' });
    }
    next();
  } catch (e) {
    console.error('[turnstile] verify request failed:', e);
    return res.status(500).json({ success: false, error: 'Internal server error. Please try again.' });
  }
}
