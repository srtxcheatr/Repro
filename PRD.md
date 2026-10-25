# PRD — SRT X CHEATS Backend

## Purpose
Node.js backend for the SRT X CHEATS key store. The PHP website talks to it for login-protected actions; admins run the business from the admin panel and from Telegram bots.

## Users
| Who | Needs |
|---|---|
| Customer (role `user`) | Register, load balance (QR top-up), buy keys, see history, report bugs |
| Reseller / Pro Reseller | Cheaper prices, API access, reseller portal |
| Admin (owner) | Load / cut balance, ban, refund, see revenue, manage products — from the panel **and** Telegram |
| Public (anyone on Telegram) | Check a reseller's account details and report them |

## Features (v6)
**Store (existing):** catalog with per-role prices, instant key checkout, balance top-up via QR + admin approval, auto-unlock Reseller (one 2000 deposit) and Pro Reseller (10+ keys + one 3500 deposit), reseller API, rewards (cosmetic missions, no cashback), leaderboard, announcements, Glory bot product.

**Private admin bot:** `/addbalance` `/cutbalance` `/alluserbalance` `/allusers_list` `/allrevenue` `/product_info` `/ban` `/unban` `/removeallrestriction` `/annulment` `/getdetail` `/mode` `/notifytest` `/cancel`. Users can be given by UID, e-mail or phone number.

**Public bot:** send number / e-mail / UID → "SRT X CHEATS USER DETAILS" card with **[Report] [Ok]**. Report text is stored (`resellerReports`) and sent to the admins.

**Alert bots (one per job):** purchase logs, website health + issues, bug reports, top-up requests / new features (private bot).

## Acceptance rules
- `/alluserbalance`: total balance + only users with balance > 0.
- `/allusers_list`: only users who loaded balance or bought keys.
- `/product_info`: partial name matches; shows every duration with User / Reseller / Pro price.
- A purchase always produces an alert in the purchase bot (success, rejected or attempt); a failed Telegram send is retried and falls back to the general bot.
- Balance can never go negative; every balance change is written to the user's `adminLog`.

## Non-goals
Replacing the PHP site, a public API for balances, moving the key purchase out of `fetchRealKey()`.

## Open questions
See `TRACKER.md` (annulment meaning, "Total spend" vs "Spend money" wording, purchase-inside-transaction risk).
