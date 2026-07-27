import express from 'express';
import userRoutes from './routes/user.js';
import adminRoutes from './routes/admin.js';
import purchaseRoutes from './routes/purchase.js';
import { CATALOG } from './src/catalog.js';
import { userCors } from './src/firebase.js';
import { telegramNotify } from './src/telegram.js';

const app = express();
app.set('trust proxy', true); // Render sits behind a proxy — this makes req.ip the real client IP
app.use(express.json());

// Catch bad JSON bodies with a clean response instead of a stack trace.
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, error: 'Invalid JSON body' });
  }
  next(err);
});

// ---- Connection logger ----
// Always notifies on errors/unauthorized attempts (401/403/5xx) — the
// "who's poking at my backend" signal you actually want. Set
// NOTIFY_ALL_REQUESTS=true on Render if you also want a ping for
// every successful request too — off by default because your own
// store polls /api/user/balance every 20s per visitor, which would
// otherwise flood your phone with routine traffic, not just problems.
const NOTIFY_ALL_REQUESTS = process.env.NOTIFY_ALL_REQUESTS === 'true';

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const isProblem = res.statusCode === 401 || res.statusCode === 403 || res.statusCode >= 500;
    if (!isProblem && !NOTIFY_ALL_REQUESTS) return;

    const origin = req.headers.origin || req.headers.referer || '—';
    const emoji = isProblem ? '🚨' : '📡';
    telegramNotify(
      `${emoji} <b>${req.method} ${req.path}</b>\n` +
      `IP: <code>${req.ip}</code>\n` +
      `Origin: ${origin}\n` +
      `Status: <b>${res.statusCode}</b>\n` +
      `${Date.now() - start}ms`
    );
  });
  next();
});

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'srtx-backend' });
});

// Public — just the display catalog (sku/name/duration/price/row).
// The actual checkout endpoint re-derives price from this same data
// server-side regardless of what a client sends, so exposing it for
// display isn't a trust boundary — it's the same prices any visitor
// already sees in the storefront UI.
app.get('/api/catalog', userCors, (req, res) => {
  res.json({ success: true, catalog: CATALOG });
});

app.use('/api/user', userRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/purchase', purchaseRoutes);

// Last-resort error handler — same job as firebase.php's shutdown
// handler: never let a raw stack trace leak to the client, always
// respond with clean JSON.
app.use((err, req, res, next) => {
  console.error('[srtx-backend] Unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, error: 'Internal server error. Please try again.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`srtx-backend listening on port ${PORT}`);
});