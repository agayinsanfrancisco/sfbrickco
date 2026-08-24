# sfbrickco — SF Brick Company (formerly sfheaux)

Telegram bot for **SF Brick Company**: sells custom 3D-printed accessories
(helmets, weapons, sci-fi/historical/fantasy upgrades and structural parts)
compatible with leading building-block brands, plus a bookable, on-site
**build-help** service in San Francisco. Payments in **crypto (BTC/LTC)**.
Data in **Supabase**.

> Branding note: deliberately avoid the "LEGO" trademark in user-facing copy —
> say "building-block brands". User-facing name is **SF Brick Company**; the
> Telegram handle is `@redbluebrick_bot` (handle only, not the brand).

## Stack

- Node.js >= 18, ESM (`"type": "module"`)
- `node-telegram-bot-api` — long-polling bot
- `@supabase/supabase-js` — service-role data access (users, orders, bookings, reviews)
- Crypto payments (no third-party processor): `@scure/bip32` + `@scure/base` +
  `@noble/hashes` derive a unique receive address per order from an account
  xpub/zpub (BIP84). `qrcode` renders the payment QR. Confirmation is on-chain
  via a polling watcher (no node, no fees, self-custodial).
- `express` — serves `/health` + the static landing page in `public/`
- OpenStreetMap Nominatim — geocoding for the distance-based Uber surcharge estimate

User-facing roles: **owner** (env `ADMIN_TELEGRAM_IDS`, full `/owner` panel incl.
Test mode) and **Block Expert** (a.k.a. "builder"/"expert" in code/DB — approved
via `/apply`, does the on-site build-help jobs, per-Block Expert rate, platform
takes a cut). Bookings/orders relay customer ↔ Block Expert/store in-bot so no
real Telegram handle or phone is exposed.

## Layout

- `index.js` — entrypoint: starts bot + server + review scheduler + payment watcher
- `src/config.js` — env loading/validation (fees, platform %, rate limits, timeouts)
- `src/supabase.js` — client + all DB helpers
- `src/crypto.js` — coin registry, USD→coin quote, receive address, payment URI + QR, on-chain confirmation lookup
- `src/hdwallet.js` — BIP84 address derivation from an account xpub/zpub
- `src/watcher.js` — polls for incoming payments and marks orders paid (`watchOnce`)
- `src/uber.js` — surcharge estimate (option A) + manual parse (option B)
- `src/bot.js` — command/callback/text routing, session state
- `src/server.js` — Express (`/health` + static landing page)
- `src/flows/` — `shop`, `booking`, `expert` (Block Expert portal: availability,
  time-off, jobs, cancel/reassign), `admin` (owner panel: users, pricing, fees,
  Test mode, reports), `account` (help/orders/forget-me), `apply` (become a
  Block Expert), `wallet` (prepaid balance + buy-a-6-pack bonus), `relay`
  (in-bot customer ↔ Block Expert/store messaging, paid orders/bookings only),
  `testmode` (owner-only: view-as any role, simulate payments), `review`,
  `payments`
- `src/lib/` — `slots` (availability), `keyboards`, `format`, `pricing`, `money`
  (pure, tested), `sessions`, `settings`, `log`
- `src/db/schema.sql` — canonical schema (already applied to the `heauxbot` Supabase project); `seed.sql`/`seed_teardown.sql` — demo data for Test mode
- `public/index.html` — landing page
- `test/` — vitest unit tests for `pricing`, `uber`, `slots`, `crypto`, `format`, `money`

## Build / Test / Run

- `npm install` — install deps
- `npm test` — run the vitest suite (`test/*.test.js`, pure logic only)
- `npm run dev` — `node --watch index.js` (auto-restart on change)
- `npm start` — `node index.js` (production)
- Setup: `cp .env.example .env` and fill it in (set `BTC_XPUB`/`LTC_XPUB`, or a
  static `BTC_ADDRESS`/`LTC_ADDRESS` fallback confirmed manually by an owner)

## Status / gotchas

- **Supabase:** schema is LIVE in project `heauxbot` (ref `wgqiwudpytvbfdnjsopo`).
  Tables: `users`, `orders`, `bookings`, `reviews` (RLS enabled, service-role only).
  Legacy `stripe_session_id` columns remain on `orders`/`bookings` — unused,
  nullable, harmless; left in place to avoid a needless live-schema migration.
- **Payments are crypto, self-custodial.** Preferred path: account xpub/zpub
  yields a unique address per order with automatic on-chain confirmation.
  Fallback (if the matching xpub is empty): a single static address confirmed
  manually by an owner.
- **Uber surcharge:** option A = distance estimate (free Nominatim geocode +
  per-mile rate, `UBER_BASE_CENTS`/`UBER_PER_MILE_CENTS`); option B = flat
  fallback (`UBER_FLAT_FALLBACK_CENTS`) when geocoding fails, an owner can
  confirm the real fare manually.
- **Platform fee** on Block Expert jobs is `PLATFORM_FEE_PCT` (currently 30%,
  taken from the Block Expert's rate, not added on top of the customer price).
- **Wallet bonus:** credited on a buyer's first qualifying 6-pack purchase only
  (once per buyer), not on every order.
- **Rename done:** working dir, GitHub repo (`agayinsanfrancisco/sfbrickco`), and
  code/package all say SF Brick Company. Still worth confirming manually: the
  Supabase project label in the dashboard and the BotFather bot
  display/about/description match (name "SF Brick Company", 3D-printed
  accessories, crypto payments).
- Long-polling bot wants a persistent process (spica via Coolify), not a Worker.
