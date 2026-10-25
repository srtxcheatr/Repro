// src by SRT X CHEATS. Copy right SRT X CHEATS
import express from 'express';
import { asyncHandler } from '../src/asyncHandler.js';
import { safeEqual } from '../src/topupQr.js';
import { depositWebhookSecret, depositToken, handleDepositUpdate } from '../src/depositBot.js';

const router = express.Router();

router.post('/deposit-webhook', asyncHandler(async (req, res) => {
  const given = req.headers['x-telegram-bot-api-secret-token'];
  if (!depositToken() || !given || !safeEqual(given, depositWebhookSecret())) return res.sendStatus(401);
  res.sendStatus(200);
  try { await handleDepositUpdate(req.body); } catch (e) { console.warn('[deposit-bot] handler error:', e?.message || e); }
}));

export default router;
