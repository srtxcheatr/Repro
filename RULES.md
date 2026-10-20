# RULES — for anyone (human or AI) changing this backend

## Money & data
1. Any balance change runs in `db().runTransaction` and appends to `adminLog` `{delta, note, resultingBalance, at}`.
2. Balance never goes negative; amounts are whole numbers, capped by `MAX_BOT_LOAD` for bot actions.
3. After every user write call `invalidateUserDoc(uid, opts)` (use `{history:false, balance}` for balance-only changes).
4. Never call an external API inside a Firestore transaction in new code.
5. Never delete user data; keep a copy (e.g. `annulledPurchases`).

## Telegram
6. Escape dynamic text with `esc()`; keep messages < 4000 chars (use `chunkBlocks`).
7. Send alerts only through `telegramNotify(text, purpose)`; pick the right purpose (`purchase`, `health`, `bug`, `balance`, `load`, `reseller`, `report`, `user`).
8. Private-bot actions: only from `TELEGRAM_TOPUP_AUTO_CHAT_ID` chats and (if set) `TELEGRAM_TOPUP_ADMIN_IDS`. Destructive actions need a confirm button (ban uses the length button as confirm).
9. Public bot: private chats only, rate-limited, no admin actions, never show UIDs of other users' purchases or keys.
10. Webhooks must verify the secret header and answer 200 immediately.

## Code
11. ES modules, no new dependencies without a reason; Node ≥ 18.
12. Keep the `// src by SRT X CHEATS. Copy right SRT X CHEATS` comment in files.
13. Secrets only in env vars — never in code, README, or logs.
14. Run `node --check` on every changed file; test money flows against a fake/emulated Firestore before deploying.
15. Add new env vars to `README.md` and `ARCHITECTURE.md`; update `TRACKER.md` and `MEMORY.md` with decisions.
