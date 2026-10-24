// src by SRT X CHEATS. Copy right SRT X CHEATS
const buckets = new Map();
const CLEANUP_EVERY_MS = 60_000;
let lastCleanup = Date.now();

// src by SRT X CHEATS. Copy right SRT X CHEATS
function clientKey(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

export function rateLimit({ windowMs = 60_000, max = 120, name = 'api', keyFn = null } = {}) {
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  return (req, res, next) => {
    const now = Date.now();
    if (now - lastCleanup > CLEANUP_EVERY_MS) {
      lastCleanup = now;
      for (const [key, value] of buckets) {
        // src by SRT X CHEATS. Copy right SRT X CHEATS
        if (now - value.startedAt > value.windowMs) buckets.delete(key);
      }
    }

    // keyFn lets a limiter bucket by authenticated user (req.uid) instead of IP; falls back to IP
    const who = (keyFn && keyFn(req)) || clientKey(req);
    const key = `${name}:${who}`;
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    let item = buckets.get(key);
    if (!item || now - item.startedAt >= windowMs) {
      item = { startedAt: now, count: 0, windowMs };
      buckets.set(key, item);
    }
// src by SRT X CHEATS. Copy right SRT X CHEATS

    item.count += 1;
    const remaining = Math.max(0, max - item.count);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
// src by SRT X CHEATS. Copy right SRT X CHEATS

    if (item.count > max) {
      const retryAfter = Math.max(1, Math.ceil((windowMs - (now - item.startedAt)) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({
        // src by SRT X CHEATS. Copy right SRT X CHEATS
        success: false,
        error: 'Too many requests. Please wait a moment and try again.'
      });
    }

    // src by SRT X CHEATS. Copy right SRT X CHEATS
    next();
  };
}

export function securityHeaders(req, res, next) {
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
}
// src by SRT X CHEATS. Copy right SRT X CHEATS

// Removes secrets (bot tokens, API keys, bearer tokens) from anything that is about to be logged or sent to chat.
const SECRET_PATTERNS = [
  [/bot\d{6,}:[A-Za-z0-9_-]{20,}/g, 'bot<redacted>'],
  [/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, '<redacted-token>'],
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>'],
  [/(\b(?:key|token|api_key|secret)=)[^&\s"']+/gi, '$1<redacted>'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '<redacted-jwt>'],
];
export function redact(value) {
  let s = typeof value === 'string' ? value : (value && (value.stack || value.message)) || String(value ?? '');
  for (const [re, rep] of SECRET_PATTERNS) s = s.replace(re, rep);
  for (const k of ['TELEGRAM_TOPUP_AUTO_BOT', 'TELEGRAM_PUBLIC_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN', 'IMGBB_API_KEY', 'ADMIN_SECRET', 'EMPLOYEE_SECRET', 'BREVO_API_KEY']) {
    const v = process.env[k];
    if (v && v.length > 8) s = s.split(v).join('<redacted>');
  }
  return s;
}
// Safe logger: one line, redacted, bounded. Never pass request bodies / tokens here.
export function safeLog(tag, err) {
  console.error(`[${tag}]`, redact(err).replace(/\s+/g, ' ').slice(0, 400));
}

// CSRF defence in depth for state-changing routes. Auth is a Bearer header (not a cookie), so classic CSRF cannot ride
// on the browser's credentials; this additionally refuses browser requests from foreign origins and non-JSON bodies.
// Requests with no Origin header (server-to-server, curl) still need a valid Firebase token.
export function requireSameSiteWrite(isAllowedOrigin) {
  return (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (origin && !isAllowedOrigin(origin)) return res.status(403).json({ success: false, error: 'Origin not allowed.' });
    if (req.headers['content-length'] !== '0' && req.headers['content-length'] !== undefined && !req.is('application/json')) {
      return res.status(415).json({ success: false, error: 'Send JSON.' });
    }
    next();
  };
}
