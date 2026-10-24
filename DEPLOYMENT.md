# Deploying the support system

## Not covered / not verified
* There is no SQL database in this project (Firestore via Admin SDK; no query strings are built from input), so "prepared SQL" does not apply.
* Not tested against a real Firebase project, real Telegram or real ImgBB. Tests use in-memory fakes (`npm test`, `node tests/bot.test.mjs`).
* `support.php` was not linted/rendered (no PHP in the build environment). Open it once after deploy.

## Environment variables (backend, Render)
Required for support: `FIREBASE_SERVICE_ACCOUNT_JSON`, `TELEGRAM_TOPUP_AUTO_BOT`, `TELEGRAM_TOPUP_AUTO_CHAT_ID`, `IMGBB_API_KEY`, `PUBLIC_BACKEND_URL` (https, so the webhook registers).
Recommended: `TELEGRAM_TOPUP_ADMIN_IDS` (comma separated Telegram user ids allowed to press buttons), `TELEGRAM_TOPUP_WEBHOOK_SECRET` (random 32+ chars).
**New requirement:** `PASSWORD_RESET_SECRET` (or `ADMIN_SECRET`) - password reset now refuses to run without one.
Website (`includes/.env`): unchanged (`BACKEND_URL`, `FIREBASE_*`). Add your site origin to `ALLOWED_ORIGINS` on the backend if it is not one of the built-in ones.

## Steps
1. Backend: `npm install`, deploy, check the log for `[topup-bot] webhook registered`.
2. Firestore: `firebase deploy --only firestore:rules,firestore:indexes` (rules are deny-all; the Admin SDK bypasses them). The index build takes a few minutes; listing works unordered meanwhile.
3. Website: deploy `storesrt-main` (Docker rebuild picks up `security.conf`).
4. Test: log in, open /support.php, send a report -> message with [Send Message] [Send Photo] appears in the admin chat -> reply to the bot's prompt -> ticket shows Solved with the reply.
5. Rotate any secret that was ever committed or logged.
