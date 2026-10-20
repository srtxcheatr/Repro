// src by SRT X CHEATS. Copy right SRT X CHEATS
import express from 'express';
import { asyncHandler } from '../src/asyncHandler.js';
import { safeEqual } from '../src/topupQr.js';
import { publicWebhookSecret, handleUpdate, publicToken } from '../src/publicBot.js';

const router = express.Router();

router.post('/public-webhook', asyncHandler(async (req, res) => {
  const given = req.headers['x-telegram-bot-api-secret-token'];
  if (!publicToken() || !given || !safeEqual(given, publicWebhookSecret())) return res.sendStatus(401);
  res.sendStatus(200);
  try { await handleUpdate(req.body); } catch (e) { console.warn('[public-bot] handler error:', e?.message || e); }
}));

export default router;
