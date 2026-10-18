// routes/rewards.js — REWARD CENTER (mounted at /api/rewards).
//
//   GET  /api/rewards          missions + progress + unlocked + equipped
//   POST /api/rewards/claim    { id }                       cashback / unlock a mission
//   POST /api/rewards/equip    { badge?, banner?, profile? }  '' = take it off
import express from 'express';
import { asyncHandler } from '../src/asyncHandler.js';
import { requireFirebaseUid, userCors } from '../src/firebase.js';
import { rateLimit } from '../src/security.js';
import { getUserDoc, invalidateUserDoc } from '../src/userCache.js';
import { leaderboardCache } from '../src/sharedCaches.js';
import { RuleError } from '../src/profileRules.js';
import { getRewardState, claimMission, setEquipped, claimStarCashback } from '../src/rewards.js';
import { telegramNotify, esc } from '../src/telegram.js';

const router = express.Router();
router.use(userCors);
router.use(requireFirebaseUid);
router.use(rateLimit({ windowMs: 60_000, max: 40, name: 'rewards' }));

const fail = (res, e) => {
  if (e instanceof RuleError) return res.status(e.status).json({ success: false, error: e.message, ...(e.extra || {}) });
  throw e;
};

router.get('/', asyncHandler(async (req, res) => {
  const snap = await getUserDoc(req.uid);
  const total = snap.exists ? Number(snap.data.totalKeysBought || 0) : 0;
  res.json({ success: true, ...(await getRewardState(req.uid, total, snap.exists ? snap.data : {})) });
}));

router.post('/claim', asyncHandler(async (req, res) => {
  let r;
  try { r = await claimMission(req.uid, req.body?.id); } catch (e) { return fail(res, e); }

  invalidateUserDoc(req.uid);     // balance changed
  leaderboardCache.invalidate();  // newly worn banner / badge must show on the board

  if (r.cashback) {
    telegramNotify(
      `🎁 <b>REWARD CLAIMED</b>\n${esc(r.mission.title)} · cashback NRP ${r.cashback}\n` +
      `✉️ ${esc(r.user.email || req.email || '—')}\n🆔 <code>${esc(req.uid)}</code>\nNRP balance now: ${esc(r.newBalance)}`, 'balance');
  }
  res.json({
    success: true, id: r.mission.id, cashback: r.cashback, newBalance: r.newBalance,
    equipped: r.equipped, unlocked: r.unlocked,
  });
}));

router.post('/claim-star', asyncHandler(async (req, res) => {
  let r;
  try { r = await claimStarCashback(req.uid); } catch (e) { return fail(res, e); }
  invalidateUserDoc(req.uid);
  telegramNotify(`⭐ <b>STAR CASHBACK</b>\nNRP ${r.cash} (${r.batches} batch)\n✉️ ${esc(r.user.email || req.email || '—')}\n🆔 <code>${esc(req.uid)}</code>\nNRP balance now: ${esc(r.newBalance)}`, 'balance');
  res.json({ success: true, cashback: r.cash, newBalance: r.newBalance });
}));

router.post('/equip', asyncHandler(async (req, res) => {
  let equipped;
  try { equipped = await setEquipped(req.uid, req.body || {}); } catch (e) { return fail(res, e); }
  leaderboardCache.invalidate();
  res.json({ success: true, equipped });
}));

export default router;
