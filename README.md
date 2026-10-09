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

Firestore reads are the scarce resource on the free plan, so shared data is cached in memory and
only re-read when it expires or when something writes to it. Defaults:

| Key | Default | What it caches |
|---|---|---|
| `CATALOG_CACHE_TTL_MS` | 600000 (10 min) | products, maintenance flags, WhatsApp products |
| `FEEDBACK_CACHE_TTL_MS` | 1800000 (30 min) | all reviews (star averages + feedback page); new reviews are patched in, not re-read |
| `LEADERBOARD_CACHE_TTL_MS` | 300000 (5 min) | top-10 leaderboard |
| `ANNOUNCEMENT_CACHE_TTL_MS` | 600000 (10 min) | active announcement |
| `POLICY_CACHE_TTL_MS` | 1800000 (30 min) | terms & policy text |
| `USER_DOC_CACHE_TTL_MS` | 60000 (1 min) | one user's document (every writer invalidates it) |

Admin/employee edits invalidate the matching cache immediately, so changes made through this backend
show up at once. If Firestore errors (including quota exhausted) the last good copy is served instead of a 500.

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
