# Las Cafe Loyalty (demo)

One Cloudflare Worker + one D1 database. Nothing to install: deploy from the dashboard.
Files: `worker.js` (all code and pages), `schema.sql` (tables and default rules).

> Note: the earlier prototype never reached me, so this was built fresh. Colors come from the 2026 palette in the brand archive (`#a58670`, `#f8f4ec`, `#3d4864`). The LAS CAFE logo is the real one, traced to a vector path (the `LOGO` constant in `worker.js`).

## Deploy (Cloudflare dashboard only)

1. **Database:** Storage & Databases → D1 → Create database (`las-loyalty`). Open its **Console** tab, paste all of `schema.sql`, and run it.
2. **Worker:** Workers & Pages → Create → Worker → Deploy the Hello World template → **Edit code**. Replace everything with `worker.js` and **Deploy**.
3. **Bind the database:** Worker → Settings → Bindings → Add → D1 database. Variable name must be exactly `DB`.
4. **Admin password:** Worker → Settings → Variables and Secrets → Add → type **Secret**, name `ADMIN_PASSWORD`. Pick something long.
5. Open `https://<your-worker>.workers.dev/admin`, log in as `admin` with that password, and add a cashier per branch (name + 4–8 digit PIN).

Pages:

| URL | Who |
|---|---|
| `/staff` | Cashier: search by phone, register, stamp, redeem |
| `/card` | Customer: enter phone, see the card. Put this URL's QR on tables (the admin page shows it) |
| `/c/LAS-XXXXXXXX` | Card opened directly from a card code |
| `/admin` | Dashboard, staff, settings |

## Demo script

1. Admin: add cashier "Sara" at العليا.
2. `/staff` as Sara: type a new phone, so it offers registration. Register "Ahmed Ali".
3. Enter 15 SAR: visit logged, no cup. Enter 25 SAR: 1 cup and 20 points.
4. Enter another bill right away: refused, 3-hour limit.
5. `/card` on a phone: the wallet-style card with the QR.
6. To reach 5 cups quickly in front of management, temporarily set "ساعات بين الأختام" (hours between stamps) to 0 in the admin settings, then set it back to 3.
7. At 5 cups, stamping is blocked and the cashier is asked for the last 4 digits. A wrong entry is logged as a failed attempt. A correct one resets the card to 0.
8. Admin: filter by branch, and show the activity log with staff name and branch.

## How it works (technical notes)

- **Identity:** the phone is normalized to `9665XXXXXXXX` (Arabic digits accepted), so `0555…`, `+966 55…` and `٠٥٥٥…` all match one row. Each customer also gets a random `card_code` (`LAS-` + 8 characters). The QR holds only this code, so a wallet pass never carries a phone number and the backend can change later.
- **One card, all branches:** `customers` has no branch. Branch lives on staff and on each `transactions` row (copied there, so history survives later renames).
- **Rules are data:** `settings` holds the minimum amount, points per order, hours between stamps, and `points_redemption` (`{"enabled":false,"points_needed":null,"value_sar":null}`). When management decides the points rule, edit that one value; no schema change. Points are stored and shown but never spent yet.
- **Reward flow:** the card shows 5 cups and a free drink at 5. The next drink is the free one, so stamping is blocked at 5. Redemption verifies the last 4 digits, then resets cups to 0. Rewards have no expiry field.
- **3-hour limit is race-safe:** the stamp is one `UPDATE … WHERE cups < 5 AND (last_stamp_at IS NULL OR last_stamp_at <= now - 3h)`. If two cashiers submit at the same moment, only one row update succeeds.
- **Auth:** PINs are stored as PBKDF2-SHA256 with a per-person salt. Sessions are HMAC-signed HttpOnly cookies (12 h), so there is no session table. The admin account is `admin` + `ADMIN_PASSWORD`.
- **Dashboard "total customers" with a branch filter** means customers who have had any activity at that branch (including being registered there). With "all branches" it is every customer.
- **Cost:** fits the Workers and D1 free tiers for a cafe's volume. A stamp is about 4 D1 queries.

## Wallet (not wired up yet)

- The customer card page already shows "Add to Apple Wallet" / "Add to Google Wallet" buttons when you save a URL in the admin settings (`wallet_apple_url`, `wallet_google_url`). For the demo, create a static pass in the free service with the customer's name and the QR text set to their `LAS-…` code, then paste that link. There is no automatic per-customer pass generation yet.
- Google Wallet generation and the January Apple Developer passes with auto-updates (a pass web service plus signing certificate) are future work. Because the QR is just the card code and all data is in D1, they can be added without touching the database.

## Known limits for a demo (fix before real launch)

- `/card` looks a customer up by phone alone and returns the first name, cups and points. Someone could probe numbers. Add Cloudflare rate limiting or Turnstile before launch.
- There is no login attempt throttle on `/api/login`.
- The QR image is drawn in the browser with `qrcode-generator` from cdnjs; if offline, the card code text still shows.
- Cashiers type the phone or card code. Camera scanning is not included.
- Tested locally against D1 (stamp, cooldown, under-20 visit, reward at 5, wrong and correct last 4, branch stats), but not in a real browser or on a real Cloudflare deploy.
