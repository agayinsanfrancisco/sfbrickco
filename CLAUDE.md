# sfbrickco — SF Brick Company (formerly sfheaux)

Telegram bot for **SF Brick Company**: sells red LEGO bricks and offers a bookable,
on-site "LEGO expert setup" service. Payments via **Stripe**. Data in **Supabase**.

## Stack

- Node.js >= 18, ESM (`"type": "module"`)
- `node-telegram-bot-api` — long-polling bot
- `@supabase/supabase-js` — service-role data access (users, orders, bookings, reviews)
- `stripe` — Checkout Sessions + webhook
- `express` — hosts the Stripe webhook (`POST /webhook/stripe`) + `/health`
- OpenStreetMap Nominatim — geocoding for the distance-based Uber surcharge estimate

## Layout

- `index.js` — entrypoint: starts bot + webhook server + review scheduler
- `src/config.js` — env loading/validation
- `src/supabase.js` — client + all DB helpers
- `src/stripe.js` — Checkout + webhook verification
- `src/uber.js` — surcharge estimate (option A) + manual parse (option B)
- `src/bot.js` — command/callback/text routing, session state
- `src/server.js` — Express + Stripe webhook
- `src/flows/` — shop, booking, expert, admin, review
- `src/lib/` — slots, keyboards, formatting
- `src/db/schema.sql` — canonical schema (already applied to the `heauxbot` Supabase project)
- `public/index.html` — Stripe-verification landing page

## Run

1. `npm install`
2. `cp .env.example .env` and fill it in
3. `npm start`

Expose `POST /webhook/stripe` publicly and register it in the Stripe dashboard; set
`STRIPE_WEBHOOK_SECRET` to the signing secret.

## Status / gotchas

- **Supabase:** schema is LIVE in project `heauxbot` (ref `wgqiwudpytvbfdnjsopo`).
  Tables: `users`, `orders`, `bookings`, `reviews` (RLS enabled, service-role only).
- **Stripe: NOT wired to the right account yet.** The MCP-connected account is
  "The Career Sprint" (`acct_1TN94...`), which is unrelated. Connect the correct
  SF Brick Company account before creating products or going live. Code precomputes
  totals via `price_data`, so no Stripe Product objects are strictly required.
- **Uber surcharge:** option A = distance estimate (free Nominatim geocode +
  per-mile rate); option B = admin confirms the fare manually if geocoding fails.
- **Rename in progress** ("everything"): package + code done. Still manual:
  rename the working dir/GitHub repo to `sf-lego-bot`, rename the Supabase project
  label in the dashboard, and set the BotFather bot display name.
- Long-polling bot wants a persistent process (spica via Coolify), not a Worker.
