import express from 'express';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import admin from 'firebase-admin';
import { getFirebaseApp, db, userCors } from '../../src/firebase.js';

const router = express.Router();
router.use(userCors);

const OTP_TTL_MS = 10 * 60 * 1000;
const RESET_TTL_MS = 10 * 60 * 1000;
const RESEND_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

function normalizeEmail(value) { return String(value || '').trim().toLowerCase(); }
function validEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
function secret() { return process.env.PASSWORD_RESET_SECRET || process.env.ADMIN_SECRET || 'change-this-secret'; }
function hash(value) { return crypto.createHmac('sha256', secret()).update(String(value)).digest('hex'); }
function randomOtp() { return String(crypto.randomInt(100000, 1000000)); }
function randomToken() { return crypto.randomBytes(32).toString('hex'); }
function docId(email) { return hash(`email:${email}`); }

function mailer() {
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = String(process.env.SMTP_SECURE || (port === 465)).toLowerCase() === 'true';
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) throw new Error('SMTP_USER and SMTP_PASS are not configured');
  return nodemailer.createTransport({ host, port, secure, auth: { user, pass } });
}

async function sendOtpEmail(email, otp) {
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  await mailer().sendMail({
    from,
    to: email,
    subject: 'SRT X CHEATS — Password Reset OTP',
    text: `Your SRT X CHEATS password reset OTP is: ${otp}\n\nThis OTP expires in 10 minutes.\n\nIf you did not request a password reset, ignore this email.`,
    html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px;background:#111;color:#fff;border-radius:14px"><h2>SRT X CHEATS</h2><p>Your password reset OTP is:</p><div style="font-size:32px;font-weight:800;letter-spacing:8px;text-align:center;padding:18px;background:#1d1730;border-radius:12px">${otp}</div><p>This OTP expires in <b>10 minutes</b>.</p><p>If you did not request a password reset, ignore this email.</p></div>`
  });
}

// POST /api/auth/forgot-password/send-otp
router.post('/forgot-password/send-otp', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!validEmail(email)) return res.status(400).json({ success:false, error:'Enter a valid email address.' });

  const ref = db().collection('passwordResetOtps').doc(docId(email));
  const old = await ref.get();
  if (old.exists) {
    const oldData = old.data() || {};
    const sentAt = Number(oldData.sentAtMs || 0);
    if (sentAt && Date.now() - sentAt < RESEND_MS) {
      return res.json({ success:true, message:'If this email belongs to an account, an OTP has been sent. Check Gmail and Spam.' });
    }
  }

  // Do not reveal whether an email exists.
  let user;
  try { user = await (getFirebaseApp(), admin.auth().getUserByEmail(email)); }
  catch (e) {
    if (e?.code === 'auth/user-not-found') {
      return res.json({ success:true, message:'If this email belongs to an account, an OTP has been sent. Check Gmail and Spam.' });
    }
    console.error('[forgot-password] lookup failed:', e);
    return res.status(500).json({ success:false, error:'Unable to process the request right now.' });
  }

  const otp = randomOtp();
  const now = Date.now();
  try {
    await sendOtpEmail(email, otp);
    await ref.set({
      email, uid:user.uid, otpHash:hash(`otp:${otp}`), sentAtMs:now,
      expiresAtMs:now + OTP_TTL_MS, attempts:0, verifiedUntilMs:0, resetTokenHash:'',
    });
  } catch (e) {
    console.error('[forgot-password] mail failed:', e);
    return res.status(500).json({ success:false, error:'Could not send the OTP email. Please try again later.' });
  }

  res.json({ success:true, message:'OTP sent. Check your Gmail Inbox and Spam folder.' });
});

// POST /api/auth/forgot-password/verify-otp
router.post('/forgot-password/verify-otp', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const otp = String(req.body?.otp || '').trim();
  if (!validEmail(email) || !/^\d{6}$/.test(otp)) return res.status(400).json({ success:false, error:'Enter the email and 6-digit OTP.' });

  const ref = db().collection('passwordResetOtps').doc(docId(email));
  const snap = await ref.get();
  if (!snap.exists) return res.status(400).json({ success:false, error:'OTP expired or not found. Request a new OTP.' });
  const data = snap.data() || {};
  if (Date.now() > Number(data.expiresAtMs || 0)) {
    await ref.delete();
    return res.status(400).json({ success:false, error:'OTP expired. Request a new OTP.' });
  }
  const attempts = Number(data.attempts || 0);
  if (attempts >= MAX_ATTEMPTS) return res.status(429).json({ success:false, error:'Too many incorrect attempts. Request a new OTP.' });
  if (hash(`otp:${otp}`) !== data.otpHash) {
    await ref.set({ attempts:attempts + 1 }, { merge:true });
    return res.status(400).json({ success:false, error:`Incorrect OTP. ${Math.max(0, MAX_ATTEMPTS - attempts - 1)} attempts remaining.` });
  }

  const resetToken = randomToken();
  await ref.set({ verifiedUntilMs:Date.now() + RESET_TTL_MS, resetTokenHash:hash(`reset:${resetToken}`), attempts:0 }, { merge:true });
  res.json({ success:true, resetToken });
});

// POST /api/auth/forgot-password/reset
router.post('/forgot-password/reset', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const resetToken = String(req.body?.resetToken || '');
  const password = String(req.body?.password || '');
  if (!validEmail(email) || !resetToken || password.length < 6) return res.status(400).json({ success:false, error:'Invalid reset request.' });

  const ref = db().collection('passwordResetOtps').doc(docId(email));
  const snap = await ref.get();
  if (!snap.exists) return res.status(400).json({ success:false, error:'Reset session expired. Start again.' });
  const data = snap.data() || {};
  if (Date.now() > Number(data.verifiedUntilMs || 0) || hash(`reset:${resetToken}`) !== data.resetTokenHash) {
    return res.status(400).json({ success:false, error:'Reset session expired or invalid. Start again.' });
  }

  try {
    getFirebaseApp();
    const user = await admin.auth().getUserByEmail(email);
    await admin.auth().updateUser(user.uid, { password });
    await ref.delete();
    res.json({ success:true, message:'Password changed successfully.' });
  } catch (e) {
    console.error('[forgot-password] reset failed:', e);
    res.status(500).json({ success:false, error:'Could not change the password. Please try again.' });
  }
});

export default router;
