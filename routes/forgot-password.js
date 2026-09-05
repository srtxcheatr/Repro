import express from 'express';
import crypto from 'crypto';
import nodemailer from 'nodemailer';

import { getFirebaseApp, db, userCors } from '../src/firebase.js';

const router = express.Router();

router.use(userCors);

const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function makeOtp() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function mailer() {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!user || !pass) {
    throw new Error('SMTP_USER and SMTP_PASS are not configured');
  }

  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
}

function otpEmailHtml(otp) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px">
      <h2>SRT Store Password Reset</h2>
      <p>Your password reset OTP is:</p>
      <div style="font-size:32px;font-weight:700;letter-spacing:8px;padding:18px 0">${otp}</div>
      <p>This OTP expires in 10 minutes.</p>
      <p>If you did not request a password reset, you can ignore this email.</p>
    </div>
  `;
}

// POST /api/auth/forgot-password/request
router.post('/forgot-password/request', async (req, res) => {
  const email = normalizeEmail(req.body?.email);

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({
      success: false,
      error: 'Enter a valid Gmail address.',
    });
  }

  // Always use the same public response for unknown emails.
  // This avoids revealing which accounts exist.
  const genericResponse = {
    success: true,
    message: 'If this email is registered, an OTP has been sent. Check Gmail Spam too.',
  };

  try {
    const app = getFirebaseApp();
    const auth = app.auth();

    let user;
    try {
      user = await auth.getUserByEmail(email);
    } catch (e) {
      return res.json(genericResponse);
    }

    const docId = hash(email);
    const ref = db().collection('passwordResetOtps').doc(docId);
    const existing = await ref.get();

    if (existing.exists) {
      const old = existing.data();
      const createdAt = Number(old.createdAt || 0);

      if (Date.now() - createdAt < RESEND_COOLDOWN_MS) {
        return res.json(genericResponse);
      }
    }

    const otp = makeOtp();
    const otpHash = hash(`${email}:${otp}`);
    const now = Date.now();

    await ref.set({
      uid: user.uid,
      email,
      otpHash,
      createdAt: now,
      expiresAt: now + OTP_TTL_MS,
      attempts: 0,
    });

    await mailer().sendMail({
      from: `"SRT Store" <${process.env.SMTP_USER}>`,
      to: email,
      subject: 'Your SRT Store password reset OTP',
      text:
        `Your SRT Store password reset OTP is ${otp}.\n\n` +
        `This OTP expires in 10 minutes.\n` +
        `If you did not request this, ignore this email.`,
      html: otpEmailHtml(otp),
    });

    return res.json(genericResponse);
  } catch (e) {
    console.error('[forgot-password/request]', e);
    return res.status(500).json({
      success: false,
      error: 'Unable to send OTP right now. Please try again later.',
    });
  }
});

// POST /api/auth/forgot-password/reset
router.post('/forgot-password/reset', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const otp = String(req.body?.otp || '').trim();
  const newPassword = String(req.body?.newPassword || '');

  if (!email || !/^\d{6}$/.test(otp)) {
    return res.status(400).json({
      success: false,
      error: 'Enter the 6-digit OTP.',
    });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({
      success: false,
      error: 'Password must be at least 6 characters.',
    });
  }

  try {
    const ref = db().collection('passwordResetOtps').doc(hash(email));
    const snap = await ref.get();

    if (!snap.exists) {
      return res.status(400).json({
        success: false,
        error: 'OTP expired or invalid. Request a new OTP.',
      });
    }

    const data = snap.data();

    if (Date.now() > Number(data.expiresAt || 0)) {
      await ref.delete();
      return res.status(400).json({
        success: false,
        error: 'OTP expired. Request a new OTP.',
      });
    }

    const attempts = Number(data.attempts || 0);

    if (attempts >= MAX_ATTEMPTS) {
      await ref.delete();
      return res.status(429).json({
        success: false,
        error: 'Too many incorrect OTP attempts. Request a new OTP.',
      });
    }

    const expected = String(data.otpHash || '');
    const supplied = hash(`${email}:${otp}`);

    if (expected.length !== supplied.length ||
        !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) {
      await ref.set({ attempts: attempts + 1 }, { merge: true });

      return res.status(400).json({
        success: false,
        error: 'Invalid OTP.',
      });
    }

    const app = getFirebaseApp();
    const auth = app.auth();

    await auth.updateUser(data.uid, {
      password: newPassword,
    });

    await ref.delete();

    return res.json({
      success: true,
      message: 'Password changed successfully. Please log in with your new password.',
    });
  } catch (e) {
    console.error('[forgot-password/reset]', e);
    return res.status(500).json({
      success: false,
      error: 'Unable to reset password right now. Please try again later.',
    });
  }
});

export default router;
