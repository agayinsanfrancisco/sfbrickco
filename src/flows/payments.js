import { config, isAdminId } from '../config.js';
import * as crypto from '../crypto.js';
import { priceForQty, RED_BRICK_SKU } from '../lib/pricing.js';
import { usd, fmtHourRange } from '../lib/format.js';
import {
  createOrder,
  getOrder,
  markOrderPaid,
  getBooking,
  markBookingPaid,
  setBookingCrypto,
  getInventory,
  decrementStock,
  nextDerivationIndex,
} from '../supabase.js';
import { notifyExpertsOfBooking } from './expert.js';

// Crypto-only payments (BTC/LTC). When an xpub is configured for a coin, each
// order gets a unique derived address and the background watcher auto-confirms
// it on-chain. Otherwise we fall back to a static address + manual admin confirm.

function methodButtons(kind, ref) {
  const rows = [];
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
  const inv = await getInventory(RED_BRICK_SKU);
  const stock = inv?.stock_qty ?? 0;
  if (stock < qty) {
    await ctx.bot.sendMessage(
      chatId,
      stock === 0
        ? '😔 Red bricks are currently sold out. Please check back soon!'
        : `Only *${stock}* red brick${stock === 1 ? '' : 's'} in stock right now. Try a smaller quantity.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  const amount = priceForQty(qty);
  const rows = methodButtons('o', qty);
  if (!rows.length) {
    await ctx.bot.sendMessage(chatId, '🛒 Payments aren’t live yet — please check back soon!');
    return;
  }
  await ctx.bot.sendMessage(
    chatId,
    `🧾 *${qty} × red brick* — total *${usd(amount)}*\nPay with crypto:`,
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
  const rows = methodButtons('b', bookingId);
  if (!rows.length) {
    await ctx.bot.sendMessage(chatId, '💳 Payments aren’t live yet — please check back soon!');
    return;
  }
  await ctx.bot.sendMessage(
    chatId,
    `🧾 Booking total *${usd(booking.total_cents)}* for ${fmtHourRange(
      booking.slot_start,
      booking.slot_end
    )}\nPay with crypto:`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } }
  );
}

// ── Issuing a payment ────────────────────────────────────────────────
// Allocate a derived address (auto-confirm) or fall back to the static one.
async function allocateAddress(coin) {
  if (crypto.hasXpub(coin)) {
    const index = await nextDerivationIndex(coin);
    return { address: crypto.receiveAddress(coin, index), index, auto: true };
  }
  return { address: crypto.receiveAddress(coin, 0), index: null, auto: false };
}

async function sendCryptoInstructions(ctx, chatId, { coin, address, amountCents, cryptoAmount, auto, kind, ref }) {
  const c = crypto.COINS[coin];
  const tail = auto
    ? 'We’ll confirm automatically once it’s on-chain (usually a few minutes).'
    : 'Once sent, tap *“I’ve sent it”* and we’ll confirm shortly.';
  const caption =
    `Send exactly *${cryptoAmount} ${c.ticker}* (≈ ${usd(amountCents)}) to:\n\n` +
    `\`${address}\`\n\n${tail}\nRate locked ~15 min; send promptly.`;
  const reply_markup = auto
    ? undefined
    : { inline_keyboard: [[{ text: '✅ I’ve sent it', callback_data: `pm:sent:${kind}:${ref}` }]] };
  try {
    const png = await crypto.qrPng(coin, cryptoAmount, address);
    await ctx.bot.sendPhoto(chatId, png, { caption, parse_mode: 'Markdown', reply_markup });
  } catch {
    await ctx.bot.sendMessage(chatId, caption, { parse_mode: 'Markdown', reply_markup });
  }
}

async function notifyAdminsToConfirm(ctx, { kind, ref, address, coin, amountCents, cryptoAmount, detail, auto }) {
  const c = crypto.COINS[coin];
  const explorer = crypto.explorerUrl(coin, address);
  const rows = [];
  if (explorer) rows.push([{ text: `🔎 View ${c.ticker} on explorer`, url: explorer }]);
  rows.push([{ text: '✅ Confirm received', callback_data: `pm:ok:${kind}:${ref}` }]);
  const head = auto ? '🟢 *New order — auto-confirming on-chain*' : '🪙 *Crypto payment pending (manual)*';
  const note = auto
    ? 'This should confirm automatically once on-chain; the button is a backup.'
    : 'Verify on the explorer, then confirm:';
  for (const adminId of config.adminIds) {
    try {
      await ctx.bot.sendMessage(
        adminId,
        `${head}\n${detail}\nExpect *${cryptoAmount} ${c.ticker}* (≈ ${usd(amountCents)}).\n${note}`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } }
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
  const inv = await getInventory(RED_BRICK_SKU);
  if ((inv?.stock_qty ?? 0) < qty) {
    await ctx.bot.sendMessage(chatId, '😔 That quantity is no longer in stock. Please try again.');
    return;
  }
  const amountCents = priceForQty(qty);
  let cryptoAmount;
  try {
    cryptoAmount = await crypto.quote(coin, amountCents);
  } catch {
    await ctx.bot.sendMessage(chatId, '⚠️ Couldn’t fetch the exchange rate. Please try again shortly.');
    return;
  }
  const { address, index, auto } = await allocateAddress(coin);
  const order = await createOrder({
    telegramId,
    qty,
    amountCents,
    paymentMethod: coin,
    cryptoAmount,
    payCoin: coin,
    // Only store the address for watching when it's a unique derived one.
    payAddress: auto ? address : null,
    payIndex: index,
  });
  await sendCryptoInstructions(ctx, chatId, {
    coin,
    address,
    amountCents,
    cryptoAmount,
    auto,
    kind: 'o',
    ref: order.id,
  });
  await notifyAdminsToConfirm(ctx, {
    kind: 'o',
    ref: order.id,
    address,
    coin,
    amountCents,
    cryptoAmount,
    detail: `Order: ${qty} × red brick`,
    auto,
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
    await ctx.bot.sendMessage(chatId, '⚠️ Couldn’t fetch the exchange rate. Please try again shortly.');
    return;
  }
  const { address, index, auto } = await allocateAddress(coin);
  await setBookingCrypto(bookingId, {
    paymentMethod: coin,
    cryptoAmount,
    payCoin: coin,
    payAddress: auto ? address : null,
    payIndex: index,
  });
  await sendCryptoInstructions(ctx, chatId, {
    coin,
    address,
    amountCents: booking.total_cents,
    cryptoAmount,
    auto,
    kind: 'b',
    ref: bookingId,
  });
  await notifyAdminsToConfirm(ctx, {
    kind: 'b',
    ref: bookingId,
    address,
    coin,
    amountCents: booking.total_cents,
    cryptoAmount,
    detail: `Booking: ${fmtHourRange(booking.slot_start, booking.slot_end)} @ ${booking.customer_address}`,
    auto,
  });
}

export async function customerSent(ctx, chatId, kind, ref) {
  await ctx.bot.sendMessage(chatId, '🙏 Thanks! We’ll verify the payment and confirm shortly.');
  for (const adminId of config.adminIds) {
    try {
      await ctx.bot.sendMessage(
        adminId,
        `🔔 Customer reports they sent payment (${kind === 'o' ? 'order' : 'booking'} ${ref}). Verify + confirm.`
      );
    } catch {
      /* ignore */
    }
  }
}

// ── Fulfillment (shared by the watcher and the manual admin button) ──
// markOrderPaid/markBookingPaid are conditional, so these are idempotent.
export async function confirmOrder(ctx, order, { auto = false } = {}) {
  const paid = await markOrderPaid(order.id);
  if (!paid) return false; // already confirmed
  const remaining = await decrementStock(RED_BRICK_SKU, order.qty);
  try {
    await ctx.bot.sendMessage(order.telegram_id, '✅ Payment confirmed! Your red bricks are on the way.');
  } catch {
    /* ignore */
  }
  for (const adminId of config.adminIds) {
    try {
      await ctx.bot.sendMessage(
        adminId,
        `✅ Order ${order.id} paid (${auto ? 'auto/on-chain' : 'manual'}). ` +
          (remaining ? `Stock now ${remaining.stock_qty}.` : '⚠️ stock check needed.')
      );
    } catch {
      /* ignore */
    }
  }
  return true;
}

export async function confirmBooking(ctx, booking, { auto = false } = {}) {
  const paid = await markBookingPaid(booking.id);
  if (!paid) return false;
  try {
    await ctx.bot.sendMessage(
      paid.customer_telegram_id,
      '✅ Payment confirmed! Finding you a LEGO expert now…'
    );
  } catch {
    /* ignore */
  }
  for (const adminId of config.adminIds) {
    try {
      await ctx.bot.sendMessage(adminId, `✅ Booking ${booking.id} paid (${auto ? 'auto/on-chain' : 'manual'}); experts notified.`);
    } catch {
      /* ignore */
    }
  }
  await notifyExpertsOfBooking(ctx, paid);
  return true;
}

// Manual admin override (static-address path, or if the watcher misses).
export async function adminConfirm(ctx, chatId, telegramId, kind, ref) {
  if (!isAdminId(telegramId)) {
    await ctx.bot.sendMessage(chatId, 'Admins only.');
    return;
  }
  if (kind === 'o') {
    const order = await getOrder(ref);
    if (!order) return ctx.bot.sendMessage(chatId, 'Order not found.');
    const ok = await confirmOrder(ctx, order, { auto: false });
    await ctx.bot.sendMessage(chatId, ok ? '✅ Confirmed.' : 'Already confirmed.');
  } else if (kind === 'b') {
    const booking = await getBooking(ref);
    if (!booking) return ctx.bot.sendMessage(chatId, 'Booking not found.');
    const ok = await confirmBooking(ctx, booking, { auto: false });
    await ctx.bot.sendMessage(chatId, ok ? '✅ Confirmed.' : 'Already confirmed.');
  }
}
