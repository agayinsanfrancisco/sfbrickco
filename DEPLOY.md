# Deploying sfbrickco to spica (Coolify Cloud)

Long-polling Telegram bot + Express webhook → needs a **persistent process**, so a
Coolify Application (Nixpacks), not a static site or Worker.

## 0. Prereqs (one-time)
- Code pushed to GitHub: `git@github.com:agayinsanfrancisco/sfheaux.git`
  (rename the GitHub repo to `sfbrickco` in repo settings if desired — update the
  remote afterward with `git remote set-url origin <new-url>`).
- Coolify Cloud reachable: `coolify ping` → `auth ok`.

## 1. Create the application (Coolify UI — one manual step)
`coolify` CLI manages existing apps but can't create one. In https://app.coolify.io:
1. **+ New → Application → Public/Private Repository** → pick the repo, branch `main`.
2. **Build Pack: Nixpacks.** Start command: `npm start` (from package.json).
3. Server: **spica**. Give it a name: `sfbrickco`.
4. Set a domain (Coolify issues a Let's Encrypt cert). Note the FQDN — the Stripe
   webhook lives at `https://<fqdn>/webhook/stripe`.
5. Health check path: `/health`.

## 2. Set environment variables (CLI, after the app exists)
```bash
coolify env sfbrickco set \
  TELEGRAM_BOT_TOKEN=… \
  SUPABASE_URL=https://wgqiwudpytvbfdnjsopo.supabase.co \
  SUPABASE_SERVICE_KEY=… \
  STRIPE_SECRET_KEY=… \
  STRIPE_WEBHOOK_SECRET=… \
  STRIPE_SUCCESS_URL=https://<fqdn>/?paid=1 \
  STRIPE_CANCEL_URL=https://<fqdn>/?canceled=1 \
  ADMIN_TELEGRAM_IDS=<your-telegram-id> \
  PORT=3000
```
Pricing/Uber vars have sane defaults (see `.env.example`); override only if needed.

## 3. Deploy
```bash
coolify deploy sfbrickco
coolify status sfbrickco
coolify logs sfbrickco --tail 100
```

## 4. Register the Stripe webhook
In the Stripe dashboard (the **correct** account — NOT "The Career Sprint"):
- Add endpoint `https://<fqdn>/webhook/stripe`, event `checkout.session.completed`.
- Copy its signing secret → update `STRIPE_WEBHOOK_SECRET` and redeploy.

## Notes
- `.env` is gitignored; secrets live only in Coolify, never in the repo.
- The bot reaches Telegram via outbound long-polling; only the webhook needs the
  public domain.
