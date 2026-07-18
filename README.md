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
