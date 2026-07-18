import express from 'express';
import userRoutes from './routes/user.js';
import adminRoutes from './routes/admin.js';
import purchaseRoutes from './routes/purchase.js';
import { CATALOG } from './src/catalog.js';
import { userCors } from './src/firebase.js';

const app = express();
app.use(express.json());

// Catch bad JSON bodies with a clean response instead of a stack trace.
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, error: 'Invalid JSON body' });
  }
  next(err);
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
