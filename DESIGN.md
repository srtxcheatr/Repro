# DESIGN

## Principles
1. Money actions are always **identify → amount → confirm button → result edited into the same message**.
2. Admin gets the same facts everywhere: name, e-mail, UID (copyable `<code>`), balance before ➝ after.
3. Nothing silent: failed alerts are retried, recorded and testable with `/notifytest`.
4. Cheap on Firestore: use `adminDirectory` for lists; single-doc reads for details.

## Message style (Telegram, HTML parse mode)
- Escape all dynamic text with `esc()`.
- Emoji prefix per type: 💰 load, ➖ cut, 🚫 ban, ✅ ok, ❌ cancelled, ⚠️ failed, 📦 product, 🚩 report.
- Lists: numbered, 3–4 lines per user, split into ≤ 3800-char messages (max 40 messages, then "use the admin panel").
- Dividers: `_________________________` (25) inside cards, 50 at the top/bottom of the public card.

## Public user card
```
__________________________________________________
SRT X CHEATS USER DETAILS
_________________________
Name - …  Number - …  Email - …  Role - …
Total spend - (money loaded)   Available balance - …
Key bought - …                 Spend money - (spent on keys)
Account status - Active | BANNED (label)
__________________________________________________
[Report]  [Ok]
```
Report → "Type your report about this reseller" → saved → admin chat. Ok → buttons removed.

## Callback data
`<prefix>:<arg>:<12-hex token>` — prefixes `ab` add, `cb` cut, `md` mode, `bn` ban, `un` unban, `an` annul; public `rp` report, `ok`. Tokens live in memory 5 min (30 min public); expired → "Expired — send the command again".

## API conventions
JSON `{ success, error? }`; 4xx for user errors, 5xx only for server faults (these trigger health alerts); admin routes use `x-admin-secret`.

## Roles & prices
`user`, `reseller`, `pro_reseller`; each product duration has `price`, `priceReseller`, `priceProReseller`.
