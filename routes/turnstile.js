import express from 'express';
import { asyncHandler } from '../src/asyncHandler.js';
import { userCors } from '../src/firebase.js';

const router = express.Router();
router.use(userCors);

// POST /api/verify-turnstile — public, no Firebase auth (this runs
// BEFORE a user has an account, on the signup form). Checks the
// widget's token against Cloudflare's own verification API using
// your secret key, which never goes to the browser.
//
// SETUP:
// 1. Cloudflare dashboard → Turnstile → Add Site → get a Site Key
//    (public) and Secret Key (private).
// 2. Site Key → includes/config.php → TURNSTILE_SITE_KEY
// 3. Secret Key → Render → this backend service → Environment →
//    TURNSTILE_SECRET_KEY
router.post('/verify-turnstile', asyncHandler(async (req, res) => {
  const token = String(req.body?.token || '');
  if (!token) {
    return res.status(400).json({ success: false, error: 'Missing verification token' });
  }

  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    // Fail closed with a clear message rather than silently letting
    // everyone through if this hasn't been configured yet.
    return res.status(500).json({ success: false, error: 'Server misconfigured: TURNSTILE_SECRET_KEY not set' });
  }

  const params = new URLSearchParams();
  params.append('secret', secret);
  params.append('response', token);
  if (req.ip) params.append('remoteip', req.ip);

  const cfRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: params,
  });
  const outcome = await cfRes.json();

  if (!outcome.success) {
    return res.status(400).json({ success: false, error: 'Verification failed. Please try again.' });
  }

  res.json({ success: true });
}));

export default router;
