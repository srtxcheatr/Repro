// src by SRT X CHEATS. Copy right SRT X CHEATS
const buckets = new Map();
const CLEANUP_EVERY_MS = 60_000;
let lastCleanup = Date.now();

// src by SRT X CHEATS. Copy right SRT X CHEATS
function clientKey(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

export function rateLimit({ windowMs = 60_000, max = 120, name = 'api' } = {}) {
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

    const key = `${name}:${clientKey(req)}`;
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
