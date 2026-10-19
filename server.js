// src by SRT X CHEATS. Copy right SRT X CHEATS
import './src/loadEnv.js';
import express from 'express';
import userRoutes from './routes/user.js';
import adminRoutes from './routes/srt_x_owner.js';
// src by SRT X CHEATS. Copy right SRT X CHEATS
import purchaseRoutes from './routes/purchase.js';
import gloryRoutes from './routes/gulaa_bot.js';
import authRoutes from './routes/auth.js';
import employeeRoutes from './routes/employee.js';
import resellerApiRoutes from './routes/reseller-api.js';
// src by SRT X CHEATS. Copy right SRT X CHEATS
import resellerPortalRoutes from './routes/reseller-portal.js';
import rewardsRoutes from './routes/rewards.js';
import telegramTopupRoutes from './routes/telegram-topup.js';
import { registerTopupWebhook } from './src/topupQr.js';
import { getLiveCatalog } from './src/srt_storage_product.js';
// src by SRT X CHEATS. Copy right SRT X CHEATS
import { userCors } from './src/firebase.js';
import { telegramNotify } from './src/telegram.js';
import { diagnoseGlory, gloryConfigured } from './src/gulaa_bot.js';
import { rateLimit, securityHeaders } from './src/security.js';
import { asyncHandler } from './src/asyncHandler.js';
// src by SRT X CHEATS. Copy right SRT X CHEATS
import { policyCache } from './src/sharedCaches.js';
import { loadVersions } from './src/versions.js';

const app = express();
app.disable('x-powered-by');
// src by SRT X CHEATS. Copy right SRT X CHEATS
app.set('trust proxy', 1);

app.use(securityHeaders);
app.use('/api/user/avatar', express.json({ limit: '800kb' }));
app.use(express.json({ limit: '16kb' }));
// src by SRT X CHEATS. Copy right SRT X CHEATS

app.use('/api', rateLimit({ windowMs: 60_000, max: 180, name: 'api' }));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    return res.status(400).json({ success: false, error: 'Invalid JSON body' });
  }
  next(err);
});

// src by SRT X CHEATS. Copy right SRT X CHEATS
const NOTIFY_ALL_REQUESTS = process.env.NOTIFY_ALL_REQUESTS === 'true';
const securityAlertSeen = new Map();
const SECURITY_ALERT_TTL = 60_000;

app.use((req, res, next) => {
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  const start = Date.now();
  res.on('finish', () => {
    const isProblem = res.statusCode === 401 || res.statusCode === 403 || res.statusCode === 429 || res.statusCode >= 500;
    if (!isProblem && !NOTIFY_ALL_REQUESTS) return;

    // src by SRT X CHEATS. Copy right SRT X CHEATS
    const alertKey = `${req.ip}|${req.method}|${req.path}|${res.statusCode}`;
    const now = Date.now();
    if (isProblem) {
      const last = securityAlertSeen.get(alertKey) || 0;
      if (now - last < SECURITY_ALERT_TTL) return;
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      securityAlertSeen.set(alertKey, now);
      for (const [k, t] of securityAlertSeen) {
        if (now - t > SECURITY_ALERT_TTL * 2) securityAlertSeen.delete(k);
      }
    }
// src by SRT X CHEATS. Copy right SRT X CHEATS

    const origin = req.headers.origin || req.headers.referer || '—';
    const emoji = isProblem ? '🚨' : '📡';
    telegramNotify(
      `${emoji} <b>${req.method} ${req.path}</b>\n` +
      // src by SRT X CHEATS. Copy right SRT X CHEATS
      `IP: <code>${req.ip}</code>\n` +
      `Origin: ${origin}\n` +
      `Status: <b>${res.statusCode}</b>\n` +
      `${Date.now() - start}ms`
    );
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  });
  next();
});

app.get('/', (req, res) => {
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  res.status(200).json({ success: true, status: 'online' });
});

app.get('/health', (req, res) => {
  res.status(200).json({ success: true, status: 'awake', uptime: process.uptime() });
// src by SRT X CHEATS. Copy right SRT X CHEATS
});

const TURNSTILE_FRONTEND_ORIGINS = process.env.TURNSTILE_FRONTEND_ORIGINS
  ? process.env.TURNSTILE_FRONTEND_ORIGINS.split(',').map((x) => x.trim()).filter(Boolean)
  : ['https://srtxcheats.ct.ws', 'http://srtxcheats.ct.ws'];
// src by SRT X CHEATS. Copy right SRT X CHEATS

function turnstileCors(req, res, next) {
  const origin = req.headers.origin;
  if (origin && !TURNSTILE_FRONTEND_ORIGINS.includes(origin)) {
    return res.status(403).json({ success: false, error: 'Origin not allowed' });
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  }
  if (origin && TURNSTILE_FRONTEND_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    // src by SRT X CHEATS. Copy right SRT X CHEATS
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  }
  next();
}
app.options('/api/security/verify', turnstileCors, (req, res) => res.sendStatus(204));
// src by SRT X CHEATS. Copy right SRT X CHEATS
app.post('/api/security/verify', turnstileCors,
  rateLimit({ windowMs: 60_000, max: 20, name: 'turnstile-gate' }),
  asyncHandler(async (req, res) => {
    const { verifyTurnstile } = await import('./src/turnstile.js');
    return verifyTurnstile(req, res, () => res.json({ success: true }));
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  })
);

app.get('/api/catalog', userCors, asyncHandler(async (req, res) => {
  const catalog = await getLiveCatalog('user');
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  res.json({ success: true, catalog });
}));

app.get('/api/policy', userCors, asyncHandler(async (req, res) => {
  res.json({ success: true, ...(await policyCache.get()) });
// src by SRT X CHEATS. Copy right SRT X CHEATS
}));

app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/admin', adminRoutes);
// src by SRT X CHEATS. Copy right SRT X CHEATS
app.use('/api/employee', employeeRoutes);
app.use('/api/purchase', purchaseRoutes);
app.use('/api/glory', gloryRoutes);
app.use('/api/rewards', rewardsRoutes);
app.use('/api/telegram', telegramTopupRoutes);
// src by SRT X CHEATS. Copy right SRT X CHEATS

app.use('/api/reseller/v1', resellerApiRoutes);
app.use('/api/reseller-portal', resellerPortalRoutes);

app.use((err, req, res, next) => {
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  console.error('[srtx-backend] Unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, error: 'Internal server error. Please try again.' });
});

// src by SRT X CHEATS. Copy right SRT X CHEATS
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`srtx-backend listening on port ${PORT}`);
  loadVersions();
  registerTopupWebhook().catch(() => {});
  // src by SRT X CHEATS. Copy right SRT X CHEATS
  if (gloryConfigured() && process.env.GLORY_DIAG_ON_START !== '0') {
    setTimeout(() => diagnoseGlory().then((l) => l.forEach((x) => console.log('[glory-diag]', x))).catch(() => {}), 3000);
  }
});
