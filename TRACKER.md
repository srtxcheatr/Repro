# TRACKER

Legend: ✅ done · 🧪 done, needs live test · ⏳ open · ❓ needs owner answer

## v6 (this update)
| # | Item | Status |
|---|---|---|
| 1 | `/cutbalance` | 🧪 |
| 2 | `/alluserbalance` (total + users with balance) | 🧪 |
| 3 | `/allusers_list` (only loaded/bought users) | 🧪 |
| 4 | `/allrevenue` | 🧪 |
| 5 | `/product_info` partial-name search, all roles + durations | 🧪 |
| 6 | `/ban` `/unban` | 🧪 |
| 7 | `/annulment` | 🧪 ❓ confirm meaning |
| 8 | Lookup by UID / e-mail / phone in all user commands | 🧪 |
| 9 | Public bot: details card + Report + Ok | 🧪 ❓ confirm "Total spend" vs "Spend money" |
| 10 | Purchase alert fix (retry, 429, supergroup migrate, parse-error fallback, fallback bot) | 🧪 |
| 11 | Purchase-logs bot (`TELEGRAM_PURCHASE_*`) | 🧪 needs BotFather token |
| 12 | Website health + issue bot, up/down monitor | 🧪 needs token + `HEALTH_CHECK_URLS` |
| 13 | `/notifytest` diagnostics | 🧪 |
| 14 | Docs: PRD, ARCHITECTURE, DESIGN, MEMORY, RULES, TRACKER | ✅ |

Offline test: 26 checks + health monitor passed against a fake Firestore/Telegram.

## Deploy checklist
- [ ] Create public / purchase / health bots in BotFather
- [ ] Set env vars (see README) incl. `PUBLIC_BACKEND_URL`
- [ ] `/start` each bot from its chat
- [ ] Run `/notifytest` in the private bot
- [ ] Make a test purchase → alert arrives in purchase bot
- [ ] Test public bot with a real number; test Report

## Backlog
- ⏳ Move `fetchRealKey()` out of the Firestore transaction (debit → fetch → refund on failure)
- ⏳ Route Glory launch/refund alerts to the purchase bot
- ⏳ Admin-panel page for `resellerReports`
- ⏳ Pagination buttons for very long `/allusers_list`
- ⏳ Optional: daily/monthly revenue in `/allrevenue`

- v7: FIXED API/portal charging reseller price to PRO accounts (User 80 / Reseller 40 / Pro 20 -> Pro was charged 40). `resellerApiCatalog` now uses `tierPrice(p, role)`; `reseller-api.js` passes the account role to product lookup + products list and aborts with ROLE_CHANGED if the tier changes between auth and debit; `reseller-portal.js` lists role prices.
