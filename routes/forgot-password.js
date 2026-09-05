import express from 'express';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import admin from 'firebase-admin';
import { getFirebaseApp } from '../src/firebase.js';

const router = express.Router();

// OTPs are kept server-side and are never returned to the browser.
const otpStore = new Map();

const OTP_TTL_MS = 10 * 60 * 1000;       // 10 minutes
const RESEND_COOLDOWN_MS = 60 * 1000;   // 60 seconds
const MAX_ATTEMPTS = 5;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function hashOtp(otp, email) {
  const salt = process.env.OTP_SALT || 'CHANGE_THIS_OTP_SALT';
  return crypto
    .createHash('sha256')
    .update(`${email}:${otp}:${salt}`)
    .digest('hex');
}

function generateOtp() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function getTransporter() {
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';

  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error('SMTP_USER and SMTP_PASS are not configured');
  }

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

async function sendOtpEmail(email, otp) {
  const transporter = getTransporter();
  const from = process.env.SMTP_FROM || `"SRT X CHEATS" <${process.env.SMTP_USER}>`;

  await transporter.sendMail({
    from,
    to: email,
    subject: 'SRT X CHEATS — Password Reset OTP',
    text:
      `Your SRT X CHEATS password reset OTP is: ${otp}\n\n` +
      `This OTP expires in 10 minutes.\n\n` +
      `If you did not request a password reset, you can ignore this email.`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.6">
        <h2>SRT X CHEATS</h2>
        <p>Your password reset OTP is:</p>
        <p style="font-size:30px;font-weight:700;letter-spacing:6px">${otp}</p>
        <p>This OTP expires in <strong>10 minutes</strong>.</p>
        <p>If you did not request a password reset, you can ignore this email.</p>
      </div>
    `,
  });
}

// POST /api/auth/forgot-password/request
router.post('/request', async (req, res) => {
  const email = normalizeEmail(req.body?.email);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({
      success: false,
      error: 'Enter a valid Gmail/email address.',
    });
  }

  const existing = otpStore.get(email);
  if (existing && Date.now() - existing.lastSentAt < RESEND_COOLDOWN_MS) {
    // Generic success avoids account enumeration.
    return res.json({ success: true });
  }

  try {
    getFirebaseApp();

    // Do not reveal whether the account exists.
    const user = await admin.auth().getUserByEmail(email).catch(() => null);

    if (user) {
      const otp = generateOtp();

      otpStore.set(email, {
        hash: hashOtp(otp, email),
        expiresAt: Date.now() + OTP_TTL_MS,
        attempts: 0,
        lastSentAt: Date.now(),
        uid: user.uid,
      });

      await sendOtpEmail(email, otp);
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('[forgot-password/request]', err);
    return res.status(500).json({
      success: false,
      error: 'Could not send OTP right now. Please try again shortly.',
    });
  }
});

// POST /api/auth/forgot-password/verify
router.post('/verify', async (req, res) => {
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

  const record = otpStore.get(email);

  if (!record || Date.now() > record.expiresAt) {
    otpStore.delete(email);
    return res.status(400).json({
      success: false,
      error: 'OTP expired. Request a new OTP.',
    });
  }

  if (record.attempts >= MAX_ATTEMPTS) {
    otpStore.delete(email);
    return res.status(429).json({
      success: false,
      error: 'Too many incorrect attempts. Request a new OTP.',
    });
  }

  if (record.hash !== hashOtp(otp, email)) {
    record.attempts += 1;
    return res.status(400).json({
      success: false,
      error: 'Incorrect OTP.',
    });
  }

  try {
    getFirebaseApp();
    await admin.auth().updateUser(record.uid, { password: newPassword });

    // One-time use.
    otpStore.delete(email);

    return res.json({ success: true });
  } catch (err) {
    console.error('[forgot-password/verify]', err);
    return res.status(500).json({
      success: false,
      error: 'Could not reset password. Please try again.',
    });
  }
});

export default router;
