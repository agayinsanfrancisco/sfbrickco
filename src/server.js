import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
import { constructWebhookEvent } from './stripe.js';
import { markOrderPaid, markBookingPaid, getBooking } from './supabase.js';
import { notifyExpertsOfBooking } from './flows/expert.js';
import { usd } from './lib/format.js';

// Express app exposing the Stripe webhook + a health check. `ctx` carries the
// Telegram bot so we can message users on payment events.
export function createServer(ctx) {
  const app = express();

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Public marketing + policy site (what Stripe reviews for verification).
  // Served at the domain root from /public.
  app.use(express.static(PUBLIC_DIR));

  // Stripe needs the raw body to verify the signature.
  app.post(
    '/webhook/stripe',
    express.raw({ type: 'application/json' }),
    async (req, res) => {
      if (!config.stripe.enabled) {
        return res.status(503).json({ error: 'payments not enabled yet' });
      }
      let event;
      try {
        event = constructWebhookEvent(req.body, req.headers['stripe-signature']);
      } catch (err) {
        console.error('webhook signature failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }

      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const meta = session.metadata || {};
        try {
          if (meta.type === 'order') {
            await markOrderPaid(meta.order_id);
            if (meta.telegram_id) {
              await ctx.bot.sendMessage(
                Number(meta.telegram_id),
                `✅ Payment received! Your red LEGOs are confirmed. We’ll be in touch on delivery.`
              );
            }
          } else if (meta.type === 'booking') {
            const booking = await markBookingPaid(meta.booking_id);
            if (meta.telegram_id) {
              await ctx.bot.sendMessage(
                Number(meta.telegram_id),
                `✅ Payment received (${usd(
                  booking?.total_cents ?? 0
                )})! Finding you a LEGO expert now…`
              );
            }
            if (booking) await notifyExpertsOfBooking(ctx, booking);
          }
        } catch (err) {
          console.error('webhook processing error:', err);
          // Still 200 so Stripe doesn't hammer retries on our own bug; we log it.
        }
      }

      res.json({ received: true });
    }
  );

  return app;
}
