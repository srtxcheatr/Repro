# MEMORY — context to keep

## Project facts
- Brand: SRT X CHEATS. Currency shown as **NRP**. Times shown in Nepal time (Asia/Kathmandu).
- Source files carry the comment `// src by SRT X CHEATS. Copy right SRT X CHEATS` — keep it.
- `src/catalog1-3.js` are empty stubs; real products live in Firestore `customProducts` / `whatsappProducts`. Product group name = field `row`; each duration is its own document.
- Phone is stored in `profilePhone` (format varies) — always match on the last 10 digits.
- Admin panel (`admin-panel-index.html`) uses `/api/admin/*`; it was not changed in v6.

## Decisions made in v6
- One Telegram bot per job; new env vars fall back to the old bot so nothing breaks.
- `/annulment` = cancel a purchase + refund (balance back, history/counters reversed, copy kept in `annulledPurchases`; the key stays with the user). *Assumed meaning — confirm with owner.*
- Public card: "Total spend" = money loaded (positive `adminLog` entries excluding refund/annul/cashback/reward/redeem notes), "Spend money" = `totalSpent`. *Assumed — confirm.*
- `/allusers_list` includes users with balance > 0, spent > 0, keys > 0 or an approved top-up.
- Telegram webhooks are exempt from the 180/min API rate limit (secret header protects them).

## Why purchase alerts were missed (analysis)
Sends had a 5 s timeout, no retry, 429s dropped; health spam shared the same chat; a cache error could skip the success alert; a wrong token/chat id is also possible → use `/notifytest`.

## Known risks (not fixed)
- `routes/purchase.js` calls `fetchRealKey()` **inside** a Firestore transaction → a retry can buy two keys; a failed commit loses a bought key. Safer design: debit first, fetch key, refund on failure.
- Render free tier sleeps; webhooks may arrive late after cold start.
- Public bot shows balance/phone/e-mail to anyone who knows the identifier (`PUBLIC_BOT_MASK_CONTACT=1` masks).

## Environment notes
- Offline tests used a fake `firebase-admin` because the npm registry was blocked in the build sandbox; real deploy still needs `npm ci`.

## Shop project product (v10)
- New product type `shopsrc` (Firestore `shopSrcProducts`, pinned to the top of the store). Buy = `POST /api/shopsrc/buy` (atomic: balance debit + `shopOrders` doc + purchaseHistory), then redirect to `registershopproject.php?order=ID`.
- Registration form -> `POST /api/shopsrc/order/:id/submit` (max 3 submits, domains reserved in `shopDomains`), logo -> imgbb via `/api/shopsrc/logo/:id`, full details go to the purchase Telegram bot.
- File is protected: signed 90 s single-use token from `/order/:id/download-link`, limit `SHOPSRC_MAX_DOWNLOADS`, source from `SHOPSRC_FILE_URL` or `SHOPSRC_FILE_PATH`. See `.env.shopsrc.example`.
- `gamer.free` is in the domain list exactly as the owner typed it — confirm it is not a typo.

## Shop order tracking (v11)
- After the buyer submits, `registershopproject.php` shows an Amazon-style tracker (stages in `STAGES`, src/shopSrc.js). Submit is one-time; download/form are hidden once submitted. History page has a "Track order" link.
- Admin panel > Shop Orders tab: list (ORDER BY / UID) > SHOW ALL DETAILS > UPDATE/UNDO per stage > SEND DETAILS (store link, admin link, unlock URL, password) which completes the order. Routes: /api/admin/shop-orders, /:id, /:id/stage, /:id/deliver.
