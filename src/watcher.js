import * as crypto from './crypto.js';
import { listWatchableOrders, listWatchableBookings } from './supabase.js';
import { confirmOrder, confirmBooking } from './flows/payments.js';

// Poll public explorers for payments to each order's derived address and
// auto-confirm once the confirmed received amount meets the quote. Only looks
// at recent, still-unpaid items so the query (and explorer calls) stay small.
const WINDOW_MS = 24 * 60 * 60 * 1000;

async function isFunded(coin, address, cryptoAmount) {
  const { confirmed } = await crypto.getConfirmedReceived(coin, address);
  return confirmed >= crypto.toSats(cryptoAmount);
}

export async function watchOnce(ctx) {
  const since = new Date(Date.now() - WINDOW_MS).toISOString();

  for (const o of await listWatchableOrders(since)) {
    if (!o.pay_coin || !o.pay_address || !o.crypto_amount) continue;
    try {
      if (await isFunded(o.pay_coin, o.pay_address, o.crypto_amount)) {
        await confirmOrder(ctx, o, { auto: true });
      }
    } catch {
      /* explorer hiccup — retry next tick */
    }
  }

  for (const b of await listWatchableBookings(since)) {
    if (!b.pay_coin || !b.pay_address || !b.crypto_amount) continue;
    try {
      if (await isFunded(b.pay_coin, b.pay_address, b.crypto_amount)) {
        await confirmBooking(ctx, b, { auto: true });
      }
    } catch {
      /* explorer hiccup — retry next tick */
    }
  }
}
