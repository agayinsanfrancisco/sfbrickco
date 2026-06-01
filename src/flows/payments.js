import { config, isAdminId } from '../config.js';
import * as crypto from '../crypto.js';
import { priceForQty } from '../lib/pricing.js';
import { usd, fmtHourRange } from '../lib/format.js';
import {
  createOrder,
  getOrder,
  markOrderPaid,
  attachOrderSession,
  getBooking,
  markBookingPaid,
  setBookingCrypto,
  attachBookingSession,
} from '../supabase.js';
import { createOrderCheckout, createBookingCheckout } from '../stripe.js';
import { notifyExpertsOfBooking } from './expert.js';

// ── Method selection ─────────────────────────────────────────────────
function methodButtons(kind, ref, amountCents) {
  const rows = [];
  if (config.stripe.enabled)
    rows.push([{ text: `💳 Card · ${usd(amountCents)}`, callback_data: `pm:${kind}:card:${ref}` }]);
  if (crypto.isCoinAvailable('btc'))
    rows.push([{ text: '₿ Bitcoin', callback_data: `pm:${kind}:btc:${ref}` }]);
  if (crypto.isCoinAvailable('ltc'))
    rows.push([{ text: 'Ł Litecoin', callback_data: `pm:${kind}:ltc:${ref}` }]);
  return rows;
}

export async function presentOrderMethods(ctx, chatId, qty) {
  if (!Number.isInteger(qty) || qty <= 0) {
    await ctx.bot.sendMessage(chatId, 'Please send a whole number greater than 0.');
    return;
  }
  ctx.sessions.delete(chatId);
  const amount = priceForQty(qty);
  const rows = methodButtons('o', qty, amount);
  if (!rows.length) {
    await ctx.bot.sendMessage(chatId, '🛒 Payments aren’t live yet — please check back soon!');
    return;
  }
  await ctx.bot.sendMessage(
    chatId,
    `🧾 *${qty} × red brick* — total *${usd(amount)}*\nChoose how to pay:`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } }
  );
}

export async function presentBookingMethods(ctx, chatId, bookingId) {
  const booking = await getBooking(bookingId);
  if (!booking) {
    await ctx.bot.sendMessage(chatId, 'That booking could not be found.');
    return;
  }
  if (booking.surcharge_source === 'pending') {
    await ctx.bot.sendMessage(chatId, 'We’re still confirming the travel surcharge. Hang tight!');
    return;
  }
  const rows = methodButtons('b', bookingId, booking.total_cents);
  if (!rows.length) {
    await ctx.bot.sendMessage(chatId, '💳 Payments aren’t live yet — please check back soon!');
    return;
  }
  await ctx.bot.sendMessage(
    chatId,
    `🧾 Booking total *${usd(booking.total_cents)}* for ${fmtHourRange(
      booking.slot_start,
      booking.slot_end
    )}\nChoose how to pay:`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } }
  );
}

// ── Card (Stripe) ────────────────────────────────────────────────────
export async function payOrderCard(ctx, chatId, telegramId, qty) {
  const amountCents = priceForQty(qty);
  const order = await createOrder({ telegramId, qty, amountCents, paymentMethod: 'stripe' });
  const session = await createOrderCheckout({ order, telegramId });
  await attachOrderSession(order.id, session.id);
  await ctx.bot.sendMessage(chatId, 'Tap to pay securely via Stripe:', {
    reply_markup: { inline_keyboard: [[{ text: `Pay ${usd(amountCents)}`, url: session.url }]] },
  });
}

export async function payBookingCard(ctx, chatId, telegramId, bookingId) {
  const booking = await getBooking(bookingId);
  if (!booking) return;
  const session = await createBookingCheckout({ booking, telegramId });
  await attachBookingSession(booking.id, session.id);
  await ctx.bot.sendMessage(chatId, 'Tap to pay securely via Stripe:', {
    reply_markup: {
      inline_keyboard: [[{ text: `Pay ${usd(booking.total_cents)}`, url: session.url }]],
    },
  });
}

// ── Crypto (static address + admin confirm) ──────────────────────────
async function sendCryptoInstructions(ctx, chatId, { coin, amountCents, cryptoAmount, kind, ref }) {
  const c = crypto.COINS[coin];
  const address = crypto.addressFor(coin);
  const caption =
    `Send exactly *${cryptoAmount} ${c.ticker}* (≈ ${usd(amountCents)}) to:\n\n` +
    `\`${address}\`\n\n` +
    `Once sent, tap *“I’ve sent it”* — we’ll confirm on-chain and then process your order. ` +
    `Rate is locked for ~15 min; send promptly.`;
  const reply_markup = {
    inline_keyboard: [[{ text: '✅ I’ve sent it', callback_data: `pm:sent:${kind}:${ref}` }]],
  };
  try {
    const png = await crypto.qrPng(coin, cryptoAmount);
    await ctx.bot.sendPhoto(chatId, png, { caption, parse_mode: 'Markdown', reply_markup });
  } catch {
    // Fall back to text if QR/photo fails.
    await ctx.bot.sendMessage(chatId, caption, { parse_mode: 'Markdown', reply_markup });
  }
}

async function notifyAdminsToConfirm(ctx, { kind, ref, who, amountCents, cryptoAmount, coin, detail }) {
  const c = crypto.COINS[coin];
  for (const adminId of config.adminIds) {
    try {
      await ctx.bot.sendMessage(
        adminId,
        `🪙 *Crypto payment pending*\n${detail}\nExpect *${cryptoAmount} ${c.ticker}* (≈ ${usd(
          amountCents
        )}) from ${who}.\nVerify on-chain, then confirm:`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: '✅ Confirm received', callback_data: `pm:ok:${kind}:${ref}` }]],
          },
        }
      );
    } catch {
      /* admin hasn't opened the bot */
    }
  }
}

export async function payOrderCrypto(ctx, chatId, telegramId, coin, qty) {
  if (!crypto.isCoinAvailable(coin)) {
    await ctx.bot.sendMessage(chatId, 'That coin isn’t available right now.');
    return;
  }
  const amountCents = priceForQty(qty);
  let cryptoAmount;
  try {
    cryptoAmount = await crypto.quote(coin, amountCents);
  } catch {
    await ctx.bot.sendMessage(chatId, '⚠️ Couldn’t fetch the exchange rate. Try again, or pay by card.');
    return;
  }
  const order = await createOrder({
    telegramId,
    qty,
    amountCents,
    paymentMethod: coin,
    cryptoAmount,
  });
  await sendCryptoInstructions(ctx, chatId, { coin, amountCents, cryptoAmount, kind: 'o', ref: order.id });
  await notifyAdminsToConfirm(ctx, {
    kind: 'o',
    ref: order.id,
    who: `Telegram ${telegramId}`,
    amountCents,
    cryptoAmount,
    coin,
    detail: `Order: ${qty} × red brick`,
  });
}

export async function payBookingCrypto(ctx, chatId, telegramId, coin, bookingId) {
  if (!crypto.isCoinAvailable(coin)) {
    await ctx.bot.sendMessage(chatId, 'That coin isn’t available right now.');
    return;
  }
  const booking = await getBooking(bookingId);
  if (!booking || booking.surcharge_source === 'pending') {
    await ctx.bot.sendMessage(chatId, 'That booking isn’t ready for payment yet.');
    return;
  }
  let cryptoAmount;
  try {
    cryptoAmount = await crypto.quote(coin, booking.total_cents);
  } catch {
    await ctx.bot.sendMessage(chatId, '⚠️ Couldn’t fetch the exchange rate. Try again, or pay by card.');
    return;
  }
  await setBookingCrypto(bookingId, { paymentMethod: coin, cryptoAmount });
  await sendCryptoInstructions(ctx, chatId, {
    coin,
    amountCents: booking.total_cents,
    cryptoAmount,
    kind: 'b',
    ref: bookingId,
  });
  await notifyAdminsToConfirm(ctx, {
    kind: 'b',
    ref: bookingId,
    who: `Telegram ${telegramId}`,
    amountCents: booking.total_cents,
    cryptoAmount,
    coin,
    detail: `Booking: ${fmtHourRange(booking.slot_start, booking.slot_end)} @ ${booking.customer_address}`,
  });
}

export async function customerSent(ctx, chatId, kind, ref) {
  await ctx.bot.sendMessage(
    chatId,
    '🙏 Thanks! We’ll verify the payment on-chain and confirm shortly.'
  );
  // Nudge admins (the confirm button was already sent when the payment was created).
  for (const adminId of config.adminIds) {
    try {
      await ctx.bot.sendMessage(
        adminId,
        `🔔 Customer reports they sent the crypto payment (${kind === 'o' ? 'order' : 'booking'} ${ref}). Verify + confirm.`
      );
    } catch {
      /* ignore */
    }
  }
}

// Admin verified the funds arrived → trigger the same fulfillment as a card payment.
export async function adminConfirm(ctx, chatId, telegramId, kind, ref) {
  if (!isAdminId(telegramId)) {
    await ctx.bot.sendMessage(chatId, 'Admins only.');
    return;
  }
  if (kind === 'o') {
    const order = await getOrder(ref);
    if (!order) {
      await ctx.bot.sendMessage(chatId, 'Order not found.');
      return;
    }
    await markOrderPaid(ref);
    await ctx.bot.sendMessage(chatId, '✅ Order marked paid.');
    try {
      await ctx.bot.sendMessage(
        order.telegram_id,
        '✅ Crypto payment confirmed! Your red bricks are on the way.'
      );
    } catch {
      /* ignore */
    }
  } else if (kind === 'b') {
    const booking = await markBookingPaid(ref);
    if (!booking) {
      await ctx.bot.sendMessage(chatId, 'Booking not found.');
      return;
    }
    await ctx.bot.sendMessage(chatId, '✅ Booking marked paid; experts notified.');
    try {
      await ctx.bot.sendMessage(
        booking.customer_telegram_id,
        '✅ Crypto payment confirmed! Finding you a LEGO expert now…'
      );
    } catch {
      /* ignore */
    }
    await notifyExpertsOfBooking(ctx, booking);
  }
}
