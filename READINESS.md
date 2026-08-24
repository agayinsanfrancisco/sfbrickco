# SF Brick Company (sfheaux → sfbrickco) — Launch Readiness

Last updated: 2026-06-13

Launch-readiness checklist in the global-CLAUDE.md format. This is a Telegram bot, so most flows are exercised in Telegram (scriptable via the Bot API, not a browser); the public landing page and `/health` are Playwright-runnable. Model: `../edocrq/docs/launch-readiness.md`.

## V1 Product Promise

A Telegram shop + on-site build-help service for custom 3D-printed building-block accessories in SF. Non-negotiables:

- **Self-custodial crypto** — each order gets a unique address derived from the xpub; funds go straight to Blake's wallet, never held.
- On-chain confirmation is automatic (polling); if it can't confirm, an admin path exists — orders never silently fail.
- Booking surcharge (distance) is estimated transparently, with a manual fallback if geocoding fails.

## In-Scope Surfaces (ship / hide / escalate)

- Shop flow (accessory catalog, bundle pricing) — **ship**
- Booking flow (1hr slots, $50/hr + distance surcharge) — **ship**
- Crypto payments (BTC/LTC, BIP84 address per order, on-chain watcher) — **ship**
- Expert notification + acceptance, customer reviews, admin panel — **ship**
- Public landing page (Stripe-policy requirement: policies + pricing) — **ship**
- `/health` + persistent process (spica via Coolify) — **ship**

## Explicitly Out of Scope for V1

Stripe card checkout (documented, not wired) · multi-vendor · loyalty.

## Audit Rules

- Verify the xpub/zpub is loaded in prod (or the static-address fallback is acceptable) before taking real orders.
- The long-polling bot needs a persistent process — confirm Coolify keeps it alive.
- Don't ship the rename half-done (code, repo, Supabase label, BotFather must all agree).

## CEO-Level Escalations Only

Pricing, the wallet/xpub config, the brand name (sfheaux → SF Brick Company / sfbrickco), legal/policies copy.

## Pre-Launch Smokes

1. **Landing page** `[Playwright]` — load the public site; confirm policies + pricing render (required for payment-processor compliance).
2. **/health** `[Playwright]` — confirm the Express health endpoint returns OK (used to verify the Coolify process is up).
3. **Crypto address derivation** `[unit]` — confirm a fresh order derives a unique, valid BTC/LTC address from the configured xpub (existing test or a one-off).
4. **Bot end-to-end** `[manual via Telegram]` — drive shop → order → payment-address display → (testnet or small) confirmation → fulfillment; and booking → surcharge estimate → expert acceptance.
5. **Geocoding fallback** `[manual]` — force a Nominatim failure; confirm the admin manual-surcharge path works.

## Active Findings

- **Gating:** finish the sfbrickco rename — GitHub repo name, Supabase project label, BotFather display name/description/about. Code-side rename is done.
- Verify xpub loaded correctly in the Coolify production env (or confirm static-address fallback is intended).
