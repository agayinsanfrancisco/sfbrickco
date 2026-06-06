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

## Layout

- `index.js` — entrypoint: starts bot + server + review scheduler + payment watcher
- `src/config.js` — env loading/validation
- `src/supabase.js` — client + all DB helpers
- `src/crypto.js` — coin registry, USD→coin quote, receive address, payment URI + QR, on-chain confirmation lookup
- `src/hdwallet.js` — BIP84 address derivation from an account xpub/zpub
- `src/watcher.js` — polls for incoming payments and marks orders paid (`watchOnce`)
- `src/flows/payments.js` — payment flow (show address/QR, await confirmation)
- `src/uber.js` — surcharge estimate (option A) + manual parse (option B)
- `src/bot.js` — command/callback/text routing, session state
- `src/server.js` — Express (`/health` + static landing page)
- `src/flows/` — shop, booking, expert, admin, review, payments
- `src/lib/` — slots, keyboards, formatting, pricing
- `src/db/schema.sql` — canonical schema (already applied to the `heauxbot` Supabase project)
- `public/index.html` — landing page

## Run

1. `npm install`
2. `cp .env.example .env` and fill it in (set `BTC_XPUB`/`LTC_XPUB`, or a static
   `BTC_ADDRESS`/`LTC_ADDRESS` fallback confirmed manually by an admin)
3. `npm start`

## Status / gotchas

- **Supabase:** schema is LIVE in project `heauxbot` (ref `wgqiwudpytvbfdnjsopo`).
  Tables: `users`, `orders`, `bookings`, `reviews` (RLS enabled, service-role only).
  Legacy `stripe_session_id` columns remain on `orders`/`bookings` — unused,
  nullable, harmless; left in place to avoid a needless live-schema migration.
- **Payments are crypto, self-custodial.** Preferred path: account xpub/zpub
  yields a unique address per order with automatic on-chain confirmation.
  Fallback (if the matching xpub is empty): a single static address confirmed
  manually by an admin.
- **Uber surcharge:** option A = distance estimate (free Nominatim geocode +
  per-mile rate); option B = admin confirms the fare manually if geocoding fails.
- **Rename in progress** ("everything"): package + code done. Still manual:
  rename the working dir/GitHub repo, rename the Supabase project label in the
  dashboard, and set the BotFather bot display/about/description (see the
  user-facing copy: name "SF Brick Company", 3D-printed accessories, crypto).
- Long-polling bot wants a persistent process (spica via Coolify), not a Worker.
