/**
 * REFERENCE IMPLEMENTATION — not wired into anything, not deployed.
 *
 * The PHP files in this project are frontend-only; the actual account
 * data lives in Firebase Auth and is managed by your separate Node
 * backend (the one BACKEND_URL points at). That backend isn't part of
 * this zip, so this file can't be tested against it — it's a drop-in
 * reference for the two endpoints passfor.php calls:
 *
 *   POST /api/auth/forgot-password/request   { email }
 *   POST /api/auth/forgot-password/verify    { email, otp, newPassword }
 *
 * Adapt the mailer block and the `app.use(...)` mount point to match
 * your actual server. Everything else should work as-is if you're
 * using Firebase Admin SDK, which you almost certainly already are
 * given the rest of this app.
 *
 * Requires: npm install firebase-admin nodemailer express
 */

const express = require('express');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const admin = require('firebase-admin'); // assumes admin.initializeApp() already ran elsewhere in your server

const router = express.Router();

// ---- In-memory OTP store -------------------------------------------------
// Fine for a single server instance. If you run multiple instances behind
// a load balancer, swap this Map for Redis (or your existing DB) so every
// instance sees the same codes.
const otpStore = new Map(); // email -> { hash, expiresAt, attempts, lastSentAt }

const OTP_TTL_MS = 10 * 60 * 1000;      // code valid for 10 minutes
const RESEND_COOLDOWN_MS = 60 * 1000;    // matches the 60s cooldown in passfor.php
const MAX_ATTEMPTS = 5;                  // wrong-code guesses allowed before the code is dead

function hashOtp(otp, email) {
    // Salting with the email keeps two users from ever coincidentally
    // colliding hashes and stops the hash being useful outside this record.
    return crypto.createHash('sha256').update(`${email}:${otp}:${process.env.OTP_SALT || 'change-me'}`).digest('hex');
}

function generateOtp() {
    return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

// ---- Mailer ---------------------------------------------------------------
// Swap this for whatever you already send email with (SendGrid, SES, Postmark...).
// Using your own domain's SMTP/API here — rather than a free/shared sender —
// is what actually fixes "the code lands in spam", far more than any code
// change on the receiving end.
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

async function sendOtpEmail(email, otp) {
    await transporter.sendMail({
        from: process.env.SMTP_FROM || '"SRT X CHEATS" <no-reply@yourdomain.com>',
        to: email,
        subject: 'Your SRT X CHEATS password reset code',
        text: `Your code is ${otp}. It expires in 10 minutes. If you didn't request this, ignore this email.`,
        html: `<p>Your code is <strong style="font-size:20px">${otp}</strong>.</p><p>It expires in 10 minutes. If you didn't request this, ignore this email.</p>`,
    });
}

// ---- POST /request ---------------------------------------------------------
router.post('/request', async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ success: false, error: 'Email is required.' });

    const existing = otpStore.get(email);
    if (existing && Date.now() - existing.lastSentAt < RESEND_COOLDOWN_MS) {
        // Still say success — don't leak timing/enumeration info to the client.
        return res.json({ success: true });
    }

    try {
        // Look up the account without revealing whether it exists.
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
        // Always respond the same way whether or not the account exists.
        return res.json({ success: true });
    } catch (err) {
        console.error('[forgot-password/request]', err);
        return res.status(500).json({ success: false, error: 'Could not send code. Try again shortly.' });
    }
});

// ---- POST /verify -----------------------------------------------------------
router.post('/verify', async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const otp = String(req.body?.otp || '').trim();
    const newPassword = String(req.body?.newPassword || '');

    if (!email || !/^\d{6}$/.test(otp)) {
        return res.status(400).json({ success: false, error: 'Invalid code.' });
    }
    if (newPassword.length < 6) {
        return res.status(400).json({ success: false, error: 'Password must be at least 6 characters.' });
    }

    const record = otpStore.get(email);
    if (!record || Date.now() > record.expiresAt) {
        otpStore.delete(email);
        return res.status(400).json({ success: false, error: 'Code expired. Request a new one.' });
    }
    if (record.attempts >= MAX_ATTEMPTS) {
        otpStore.delete(email);
        return res.status(429).json({ success: false, error: 'Too many attempts. Request a new code.' });
    }
    if (record.hash !== hashOtp(otp, email)) {
        record.attempts++;
        return res.status(400).json({ success: false, error: 'Incorrect code.' });
    }

    try {
        await admin.auth().updateUser(record.uid, { password: newPassword });
        otpStore.delete(email); // one-time use
        return res.json({ success: true });
    } catch (err) {
        console.error('[forgot-password/verify]', err);
        return res.status(500).json({ success: false, error: 'Could not reset password. Try again.' });
    }
});

module.exports = router;

// In your main server file:
//   app.use('/api/auth/forgot-password', require('./forgot-password'));
