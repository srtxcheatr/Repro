# BOTS — full list

You do **not** need 10 bots. Any bot you leave unset falls back to the **General bot (#9)**, and #9 falls back to the old `TELEGRAM_BOT_TOKEN`. Start with #1–#4, add the rest when you want separate chats.

All values go in Render → Environment (template: `.env.telegram.example`). Every chat must send `/start` to its bot first (or the bot must be in the group).

| # | Bot | Token env | Chat env | Webhook? |
|---|---|---|---|---|
| 1 | **Private admin bot** | `TELEGRAM_TOPUP_AUTO_BOT` | `TELEGRAM_TOPUP_AUTO_CHAT_ID`, `TELEGRAM_TOPUP_ADMIN_IDS` | yes `/api/telegram/topup-webhook` |
| 2 | **Public bot** | `TELEGRAM_PUBLIC_BOT_TOKEN` | – | yes `/api/telegram/public-webhook` |
| 3 | **User purchase logs bot** | `TELEGRAM_PURCHASE_BOT_TOKEN` | `TELEGRAM_PURCHASE_CHAT_ID` | no (send only) |
| 4 | **Website health + issue bot** | `TELEGRAM_HEALTH_BOT_TOKEN` | `TELEGRAM_HEALTH_CHAT_ID` | no |
| 5 | **User bug report bot** | `TELEGRAM_BUG_BOT_TOKEN` | default chat ids | no |
| 6 | **Balance / top-up request bot** | `TELEGRAM_BALANCE_BOT_TOKEN` | default chat ids | no |
| 7 | **Load alert bot** | `TELEGRAM_LOAD_BOT_TOKEN` | `TELEGRAM_LOAD_CHAT_ID` (set both) | no |
| 8 | **Reseller / API bot** | `TELEGRAM_RESELLER_BOT_TOKEN` | default chat ids | no |
| 9 | **General alert bot** (fallback) | `TELEGRAM_USER_BOT_TOKEN` | default chat ids | no |
| 10 | Report bot (optional) | `TELEGRAM_REPORT_BOT_TOKEN` | `TELEGRAM_REPORT_CHAT_ID` | no |

Default chat ids: `TELEGRAM_CHAT_ID_1`, `TELEGRAM_CHAT_ID_2`, `TELEGRAM_CHAT_ID`. Last fallback for everything: `TELEGRAM_BOT_TOKEN`.
Also needed: `PUBLIC_BACKEND_URL` (https backend URL) for the two webhook bots.

## What each bot does

### 1. Private admin bot
- Top-up requests from the website with **Load ✅ / Cancel ❌** buttons (fake-payment strikes on cancel)
- Pro Reseller requests with Approve / Cancel
- Commands (user = UID, e-mail or phone):
  `/addbalance` `/cutbalance` `/alluserbalance` `/allusers_list` `/allrevenue` `/product_info` `/ban` `/unban` `/annulment` `/getdetail` `/mode` `/notifytest` `/cancel`
- Receives reseller reports from the public bot

### 2. Public bot
Anyone sends a phone number, e-mail or UID → "SRT X CHEATS USER DETAILS" card → **[Report] [Ok]**. Private chats only, 10 lookups/min per person, 3 reports/hour.

### 3. Purchase logs bot
🛒 Purchase attempt · ✅ Purchase success (with key and balance before ➝ after) · ❌ Purchase rejected · Checkout banned (1h)

### 4. Website health + issue bot
🟢 Backend started · 🚨 401/403/429/5xx responses · 🔥 Server error / crash · 🔴 Site/Firestore DOWN · 🟢 BACK UP

### 5. Bug report bot
🐛 Bug reports sent by users from the website.

### 6. Balance / top-up request bot
Balance load requests from the website, rejected balance loads, STAR cashback.

### 7. Load alert bot
Every balance load / cut / annulment refund made by admin panel, private bot or Telegram.

### 8. Reseller / API bot
API orders and settlement problems, API credentials created/regenerated, reseller API turned ON/OFF.

### 9. General alert bot
User banned / unbanned, Glory bot alerts (launched, failed, refund problems), reseller self-upgrade. Also receives a copy of any purchase/health/report alert whose own bot failed.

### 10. Report bot
Only used for public-bot reports if the private admin bot (#1) is not configured.

## Quick test
Send `/notifytest` in the private bot: it sends a test through every alert bot and shows the exact Telegram error for any that fail.
