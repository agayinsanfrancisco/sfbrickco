# sfbrickco

Telegram bot for **SF Brick Company** — sells red LEGO bricks and lets customers book an
on-site **LEGO expert** for setup help. Payments via **Stripe**, data in **Supabase**.

## Features

- 🧱 **Shop** — buy red bricks ($10 each, 6 for $45; bundle pricing auto-applied)
- 🛠️ **Book an expert** — $50/hr flat fee + travel surcharge
  - **Surcharge option A:** estimated from driving distance (Civic Center → you)
  - **Surcharge option B:** if the address can't be geocoded, an admin confirms the
    exact Uber fare before the customer is charged
- 🗓️ **Scheduling** — 1-hour slots, available 24/7
- 👷 **Experts** — get notified of paid bookings and accept them (first-come)
- ⭐ **Reviews** — customers are prompted automatically after each appointment ends
- ⚙️ **Admin** — add/remove users, promote experts, view pending bookings,
  accept on behalf of an expert, and confirm manual fares
- 💳 **Stripe Checkout** for every charge, confirmed via webhook

## Setup

```bash
npm install
cp .env.example .env   # then fill in every value
npm start
```

### Required services

1. **Telegram** — create a bot with [@BotFather](https://t.me/BotFather), put the token
   in `TELEGRAM_BOT_TOKEN`. Add your own numeric Telegram ID to `ADMIN_TELEGRAM_IDS`.
2. **Supabase** — schema is already applied to the `heauxbot` project. For a fresh
   project, run `src/db/schema.sql`. Use the **service-role** key in `SUPABASE_SERVICE_KEY`.
3. **Stripe** — set `STRIPE_SECRET_KEY`. Expose `POST /webhook/stripe` publicly
   (e.g. via your Coolify domain or `stripe listen` in dev), then set
   `STRIPE_WEBHOOK_SECRET` to that endpoint's signing secret.

### Dev webhook

```bash
stripe listen --forward-to localhost:3000/webhook/stripe
```

## How payment → fulfillment works

1. Customer pays via a Stripe Checkout link.
2. Stripe calls `POST /webhook/stripe` on `checkout.session.completed`.
3. The bot marks the order/booking paid and:
   - **orders** → confirms to the customer
   - **bookings** → notifies all active experts, who can accept

## Deploy

Long-polling needs a persistent process — deploy to **spica via Coolify** (not a Worker).
Point a public domain at `POST /webhook/stripe` and register it in Stripe.

## Landing page

`public/index.html` is a self-contained marketing + policy page built to satisfy
Stripe's website-verification requirements (products, pricing, refund/cancellation
policy, privacy, terms, contact). **Replace every `[REPLACE]` placeholder** with real
business details before submitting to Stripe.
