import Stripe from 'stripe';
import { config } from './config.js';

// Lazy client: the app can boot (and serve the website) before Stripe is
// connected. The client is only created when a payment is actually attempted.
let _stripe = null;
function client() {
  if (!config.stripe.enabled) {
    throw new Error('Stripe is not configured yet (missing STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET).');
  }
  if (!_stripe) _stripe = new Stripe(config.stripe.secretKey);
  return _stripe;
}

// Checkout for a LEGO product order. We precompute the exact total, so we use
// a single line item priced at the full amount with quantity 1.
export async function createOrderCheckout({ order, telegramId }) {
  const session = await client().checkout.sessions.create({
    mode: 'payment',
    success_url: config.stripe.successUrl,
    cancel_url: config.stripe.cancelUrl,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: order.amount_cents,
          product_data: {
            name: `Red LEGOs ×${order.qty}`,
            description: 'Heaux SF — red LEGO order',
          },
        },
      },
    ],
    metadata: {
      type: 'order',
      order_id: order.id,
      telegram_id: String(telegramId),
    },
  });
  return session;
}

// Checkout for an expert-setup booking: base service fee + Uber surcharge,
// shown as two line items so the customer sees the breakdown.
export async function createBookingCheckout({ booking, telegramId }) {
  const lineItems = [
    {
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: booking.service_fee_cents,
        product_data: {
          name: 'LEGO expert setup (1 hour)',
          description: 'On-site LEGO setup help',
        },
      },
    },
  ];
  if (booking.surcharge_cents > 0) {
    lineItems.push({
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: booking.surcharge_cents,
        product_data: {
          name: 'Travel surcharge (Uber, Civic Center → you)',
          description:
            booking.surcharge_source === 'estimate'
              ? 'Estimated from distance'
              : 'Confirmed fare',
        },
      },
    });
  }

  const session = await client().checkout.sessions.create({
    mode: 'payment',
    success_url: config.stripe.successUrl,
    cancel_url: config.stripe.cancelUrl,
    line_items: lineItems,
    metadata: {
      type: 'booking',
      booking_id: booking.id,
      telegram_id: String(telegramId),
    },
  });
  return session;
}

export function constructWebhookEvent(rawBody, signature) {
  return client().webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
}
