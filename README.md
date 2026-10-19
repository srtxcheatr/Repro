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

`ALLOWED_ORIGINS`, `ALLOWED_ORIGIN_SUFFIXES`, `TURNSTILE_FRONTEND_ORIGINS` (comma separated) extend the
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
