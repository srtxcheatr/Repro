# Backend v5 — Node.js

Same functionality as the PHP backend, rewritten in Node.js because
Firestore's PHP client requires a compiled gRPC extension (10-40 min
builds, sometimes failing on Render's free tier). Node's
`firebase-admin` uses `@grpc/grpc-js` — pure JavaScript, no
compilation, no PECL. This is the fix for the actual root cause of
most of the deploy problems this project has hit.

## Setup on Render

**No Dockerfile needed this time** — Render has native Node.js support.

1. Render → **New +** → **Web Service** → connect your repo
2. **Runtime**: Node
3. **Build Command**: `npm install`
4. **Start Command**: `npm start`
5. **Instance Type**: Free

## Environment variables

Same names as before — Environment tab:

| Key | Required for |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Everything — paste the whole JSON file content |
| `ADMIN_SECRET` | Admin panel/endpoints |
| `RESELLER_WORKER_URL` | Only once you fill in `fetchRealKey()` |
| `WORKER_INTERNAL_SECRET` | Same |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Optional — purchase/top-up notifications |
| `IMGBB_API_KEY` | Profile pictures — your key from https://api.imgbb.com/ (stays on the server, never sent to the browser) |
| `IMGBB_ENDPOINT` | Optional — defaults to `https://api.imgbb.com/1/upload` |

### Cache tuning (all optional, milliseconds)

Firestore reads are the scarce resource on the free plan (50K/day), so everything shared is cached in
memory and re-read only when it expires **or when something writes to it** (every writer invalidates the
matching cache, so admin edits show up at once).

| Key | Default | What it caches |
|---|---|---|
| `CATALOG_CACHE_TTL_MS` | 21600000 (6 h) | products, maintenance flags, WhatsApp products |
| `FEEDBACK_CACHE_TTL_MS` | 21600000 (6 h) | all reviews (new reviews are patched in, not re-read) |
| `LEADERBOARD_CACHE_TTL_MS` | 600000 (10 min) | top-10 leaderboard |
| `ANNOUNCEMENT_CACHE_TTL_MS` | 21600000 (6 h) | active announcement + the admin list |
| `POLICY_CACHE_TTL_MS` | 21600000 (6 h) | terms & policy text |
| `USER_DOC_CACHE_TTL_MS` | 300000 (5 min) | one user's document (every writer invalidates it) |
| `ADMIN_DIRECTORY_TTL_MS` | 43200000 (12 h) | admin panel user list / stats / rankings (full re-read safety net) |

If you edit Firestore by hand in the console (not through this backend) the change shows up after the TTL.
If Firestore errors (including quota exhausted) the last good copy is served instead of a 500.

### How reads are kept low

* **Admin panel** — `/api/admin/stats`, `/users`, `/rankings` are served from one in-memory directory
  (`src/adminDirectory.js`): the users collection is read once, afterwards only users that changed are re-read.
* **Change detection** — browsers poll `GET /api/user/sync` (zero Firestore reads). Stamps live in the
  Firestore doc `config/versions`, so a server sleep/restart does NOT make every browser refetch everything.
  Balance, history, catalog, announcement, feedback, policy each have their own stamp.
* **Balance-only changes** (admin load/deduct, employee load, redeem, cashback) — up-to-date browsers patch the
  balance in their local cache with no request at all. Writers opt in with
  `invalidateUserDoc(uid, { history: false, balance: newBalance })` (see `src/userCache.js`).
* **Announcements** — fetched once, cached in the browser until the admin publishes or switches one off.
  Switching off only sets `active:false`; the document stays in Firestore.

### Optional config overrides

`ALLOWED_ORIGINS`, `ALLOWED_ORIGIN_SUFFIXES` (comma separated) extend the
built-in origin lists. The website reads `BACKEND_URL`, `SITE_URL`, `WHATSAPP_TOPUP_NUMBER`, `FIREBASE_*` etc.
from `includes/.env` / server env (defaults are unchanged).

## What's NOT included, same as always

**`routes/purchase.js`** has `fetchRealKey()` at the top — it's a stub
that throws `"not implemented"`. That's your reseller call. Everything
around it (price lookup, atomic balance check, rollback-on-failure,
Telegram notifications) is complete and tested.

## Routes (clean paths, no `.php`)

```
POST /api/user/init
GET  /api/user/balance
POST /api/user/profile
GET  /api/user/history
POST /api/user/history-clear
POST /api/user/topup
GET  /api/user/keys
POST /api/user/keys

GET  /api/admin/lookup?uid=... (or ?email=...)
POST /api/admin/adjust-balance
POST /api/admin/set-status
POST /api/admin/topup-review

POST /api/purchase/checkout
```

Note the checkout path changed from `/api/purchase/balance` (PHP) to
`/api/purchase/checkout` (Node) — update anything that calls it.

## Local testing (optional, before deploying)

```
npm install
FIREBASE_SERVICE_ACCOUNT_JSON='...' ADMIN_SECRET='test' PORT=8099 npm start
```

Then in another terminal: `curl http://localhost:8099/` should return
`{"ok":true,"service":"srtx-backend"}`.

## Deploy

```
cd backend-node
git init
git add .
git commit -m "Node.js backend"
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git branch -M main
git push -u origin main --force
```

Push to Render, watch Logs — should say `srtx-backend listening on
port ...` within seconds, not minutes. No gRPC compile step at all.


## Telegram bots (v6)

One bot per job. Every new variable falls back to the old bot, so nothing stops working while you set them up.

| Bot | Token env | Chat env | What it does |
|---|---|---|---|
| Private admin bot (already there) | `TELEGRAM_TOPUP_AUTO_BOT` | `TELEGRAM_TOPUP_AUTO_CHAT_ID`, `TELEGRAM_TOPUP_ADMIN_IDS` | top-up requests + admin commands (below) |
| **Public bot** (new) | `TELEGRAM_PUBLIC_BOT_TOKEN` | – | anyone sends a number / e-mail / UID, gets the user-details card with [Report] [Ok] |
| **Purchase logs bot** (new) | `TELEGRAM_PURCHASE_BOT_TOKEN` | `TELEGRAM_PURCHASE_CHAT_ID` | every key purchase: attempt / success / rejected |
| **Website health + issue bot** (new) | `TELEGRAM_HEALTH_BOT_TOKEN` | `TELEGRAM_HEALTH_CHAT_ID` | backend started, 401/403/429/5xx alerts, server errors, site/Firestore down + back up |
| Bug report bot (already there) | `TELEGRAM_BUG_BOT_TOKEN` | (default chat ids) | bug reports sent from the website |

Other new variables: `PUBLIC_BACKEND_URL` (https URL of this backend, needed so Telegram can reach both webhooks),
`TELEGRAM_PUBLIC_WEBHOOK_SECRET` (optional), `PUBLIC_BOT_MASK_CONTACT=1` (optional, hides the middle of the number/e-mail in the public card),
`TELEGRAM_REPORT_BOT_TOKEN` / `TELEGRAM_REPORT_CHAT_ID` (optional, only used if the private bot is not set),
`HEALTH_CHECK_URLS` (comma separated, e.g. your website + `https://<backend>/health`), `HEALTH_CHECK_INTERVAL_MS` (default 300000),
`HEALTH_CHECK_FIRESTORE=1`.

Make sure every chat id has already sent `/start` to its bot (or the bot is added to the group) - otherwise Telegram refuses the message.
Run **/notifytest** in the private bot to see which bot reaches you and the exact Telegram error for the ones that do not.

### Private bot commands

`/addbalance` `/cutbalance` `/alluserbalance` `/allrevenue` `/allusers_list` `/product_info` `/ban` `/unban` `/annulment` `/getdetail` `/mode` `/notifytest` `/cancel`

A user can be given as **UID, e-mail or phone number**.

* `/alluserbalance` - total balance + every user who holds a balance (NRP 0 users are not shown)
* `/allusers_list` - every user who loaded balance or bought keys (never-deposited / never-bought users are not shown)
* `/product_info PHANTOM` - any part of a product name; lists every matching product with all durations and the User / Reseller / Pro Reseller price
* `/annulment` - pick one of the user's last purchases, confirm, and it is refunded (balance back, history/counters reversed, record kept in `annulledPurchases`). The key itself stays with the user.
* Reseller reports from the public bot are stored in the Firestore collection `resellerReports`.


## Support tickets (`/support.php` on the website)

API: `GET /api/support/overview`, `GET /api/support/tickets/:id`, `POST /api/support/tickets`, `POST /api/support/tickets/:id/cancel`
(all need the Firebase login token). Code: `routes/support.js`, `src/supportStore.js` (data), `src/supportBot.js` (Telegram).

* Tickets are announced by the **private admin bot** (`TELEGRAM_TOPUP_AUTO_BOT`) in the `TELEGRAM_TOPUP_AUTO_CHAT_ID` chats, with
  `[Send Message] [Send Photo]` buttons. No new env var is needed; photos use the existing `IMGBB_API_KEY` (server side only).
* The admin must **reply to the bot's prompt** (Telegram force-reply). Every prompt has its own Firestore session, so
  simultaneous replies for different tickets/admins never get mixed up.
* Firestore: collections `supportTickets`, `supportPending` (one-pending-ticket lock), `supportSessions`. Deploy
  `firestore.indexes.json` (uid + createdAt) - until then the list falls back to an unordered read.
* Password reset now needs `PASSWORD_RESET_SECRET` (or `ADMIN_SECRET`); there is no built-in fallback secret any more.
* Tests: `npm test` and `node tests/bot.test.mjs` (the bot test needs `npm install` first).
