# ARCHITECTURE

## Stack
Node ≥ 18 (ES modules) · Express 4 · `firebase-admin` (Firestore) · hosted on Render (free tier, sleeps) · Telegram Bot API via webhooks · PHP website (separate project) calls this backend.

## Folders
```
server.js                 app wiring, rate limit, health alerts, route mounting
routes/
  purchase.js             /api/purchase  checkout job (balance tx → fetchRealKey → history)
  user.js auth.js         user profile, top-up requests, bug report
  srt_x_owner.js          /api/admin  admin panel API (x-admin-secret)
  employee.js reseller-*.js rewards.js gulaa_bot.js keys-lookup.js
  telegram-topup.js       /api/telegram/topup-webhook   (private bot)
  telegram-public.js      /api/telegram/public-webhook  (public bot)
src/
  telegram.js             telegramNotify(text, purpose) — retries, fallback, diagnostics
  telegramBot.js          private bot commands + button callbacks
  publicBot.js            public bot (lookup, report)
  adminOps.js             findUserByAny, credit/debit, ban/unban, annulment, reports
  productInfo.js          /product_info search
  healthMonitor.js        URL / Firestore up-down alerts
  topupQr.js              private bot transport (tg()), QR top-up approve/cancel
  adminDirectory.js       in-memory users directory (no extra Firestore reads)
  userCache.js versions.js cache.js  caching + change stamps
  srt_storage_product.js  catalog (static + customProducts + whatsappProducts + overrides)
  proTier.js ban.js balanceAlerts.js firebase.js ...
```

## Firestore collections
`users/{uid}` (balance, role, profileName, profilePhone, email, totalSpent, totalKeysBought, purchaseHistory[], adminLog[], topupRequests[], ban/banned, annulledPurchases[], starCb, proReseller, fakePayment) · `customProducts` · `whatsappProducts` · `productStatus` · `feedback` · `topupQr` · `resellerReports` (new) · `config/versions` · others per route.

## Bots
| Purpose | Token env | Chat env | Fallback |
|---|---|---|---|
| private admin | `TELEGRAM_TOPUP_AUTO_BOT` | `TELEGRAM_TOPUP_AUTO_CHAT_ID`, `TELEGRAM_TOPUP_ADMIN_IDS` | – |
| public | `TELEGRAM_PUBLIC_BOT_TOKEN` | – | – |
| purchase | `TELEGRAM_PURCHASE_BOT_TOKEN` | `TELEGRAM_PURCHASE_CHAT_ID` | user bot |
| health | `TELEGRAM_HEALTH_BOT_TOKEN` | `TELEGRAM_HEALTH_CHAT_ID` | user bot |
| bug / user / balance / load / reseller / report | `TELEGRAM_*_BOT_TOKEN` | default chat ids | legacy `TELEGRAM_BOT_TOKEN` |

Webhooks need `PUBLIC_BACKEND_URL` (https). Secret header is verified on both webhooks.

## Key flows
**Purchase:** `POST /api/purchase/checkout/start` → checks → job id → `runCheckoutJob`: attempt alert → Firestore tx (balance check, `fetchRealKey`, write history/counters) → cache invalidate → success alert. Any error → job failed + rejected alert.

**Private bot command:** message → `handleMessage` (admin chat + admin id check) → session (identify → amount) → inline-button confirm → `handleBotCallback` → op in `adminOps.js` → `invalidateUserDoc` → message edited with result.

**Public bot:** message → rate limit → `findUserByAny` (phone matched on last 10 digits through the directory) → card → Report → text → Firestore + admin chat.

## Caching
Catalog 6 h, users directory 12 h with dirty refresh, user doc 5 min. **Every writer must call `invalidateUserDoc(uid, …)`** or the panel/bots show stale data.
