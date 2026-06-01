import { config, isAdminId } from '../config.js';
import * as crypto from '../crypto.js';
import { usd, fmtHourRange } from '../lib/format.js';
import {
  getOrder,
  markOrderPaid,
  updateOrderCrypto,
  markOrderDispatched,
  decrementStock,
  getProduct,
  getBooking,
  markBookingPaid,
  setBookingCrypto,
  nextDerivationIndex,
} from '../supabase.js';
import { notifyExpertsOfBooking } from './expert.js';

// Crypto-only payments (BTC/LTC). With an xpub configured, each order gets a
// unique derived address and the watcher auto-confirms on-chain; otherwise a
// static address + manual admin confirmation is used.

function methodButtons(kind, ref) {
  const rows = [];
  if (crypto.isCoinAvailable('btc'))
    rows.push([{ text: '₿ Bitcoin', callback_data: `pm:${kind}:btc:${ref}` }]);
  if (crypto.isCoinAvailable('ltc'))
    rows.push([{ text: 'Ł Litecoin', callback_data: `pm:${kind}:ltc:${ref}` }]);
  return rows;
}

// Order row already created (with delivery + contact). Show totals + methods.
export async function presentOrderMethods(ctx, chatId, order, product) {
  const total = order.amount_cents + order.delivery_fee_cents;
  const rows = methodButtons('o', order.id);
  if (!rows.length) {
    await ctx.bot.sendMessage(chatId, '🛒 Payments aren’t live yet — please check back soon!');
    return;
  }
  await ctx.bot.sendMessage(
    chatId,
    `🧾 *${order.qty} × ${product?.name || order.sku}*\n` +
      `• Items: ${usd(order.amount_cents)}\n` +
      `• Courier delivery: ${usd(order.delivery_fee_cents)}\n` +
      `• *Total: ${usd(total)}*\nPay with crypto:`,
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

export async function payOrderCrypto(ctx, chatId, telegramId, coin, orderId) {
  if (!crypto.isCoinAvailable(coin)) {
    await ctx.bot.sendMessage(chatId, 'That coin isn’t available right now.');
    return;
  }
  const order = await getOrder(orderId);
  if (!order || order.status !== 'pending') {
    await ctx.bot.sendMessage(chatId, 'That order is no longer awaiting payment.');
    return;
  }
  const product = await getProduct(order.sku);
  if ((product?.stock_qty ?? 0) < order.qty) {
    await ctx.bot.sendMessage(chatId, '😔 That item is no longer in stock. Please start a new order.');
    return;
  }
  const total = order.amount_cents + order.delivery_fee_cents;
  let cryptoAmount;
  try {
    cryptoAmount = await crypto.quote(coin, total);
  } catch {
    await ctx.bot.sendMessage(chatId, '⚠️ Couldn’t fetch the exchange rate. Please try again shortly.');
    return;
  }
  const { address, index, auto } = await allocateAddress(coin);
  await updateOrderCrypto(orderId, {
    paymentMethod: coin,
    cryptoAmount,
    payCoin: coin,
    payAddress: auto ? address : null,
    payIndex: index,
  });
  await sendCryptoInstructions(ctx, chatId, {
    coin,
    address,
    amountCents: total,
    cryptoAmount,
    auto,
    kind: 'o',
    ref: orderId,
  });
  await notifyAdminsToConfirm(ctx, {
    kind: 'o',
    ref: orderId,
    address,
    coin,
    amountCents: total,
    cryptoAmount,
    detail: `Order: ${order.qty} × ${product?.name || order.sku} → ${order.delivery_address}`,
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

// ── Fulfillment (shared by watcher + manual admin button) ────────────
export async function confirmOrder(ctx, order, { auto = false } = {}) {
  const paid = await markOrderPaid(order.id);
  if (!paid) return false; // already confirmed
  const remaining = await decrementStock(order.sku, order.qty);
  try {
    await ctx.bot.sendMessage(
      order.telegram_id,
      '✅ Payment confirmed! We’re preparing your order for courier delivery.'
    );
  } catch {
    /* ignore */
  }
  const detail =
    `📦 *Paid order — ready to dispatch*\n` +
    `${order.qty} × ${order.sku}\n` +
    `📍 ${order.delivery_address}\n` +
    `📞 ${order.contact_phone || '—'}${order.contact_handle ? ` (@${order.contact_handle})` : ''}\n` +
    `Delivery fee ${usd(order.delivery_fee_cents)} · paid ${auto ? 'auto/on-chain' : 'manual'}` +
    (remaining ? `\nStock now ${remaining.stock_qty}.` : '');
  for (const adminId of config.adminIds) {
    try {
      await ctx.bot.sendMessage(adminId, detail, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🚚 Accept & dispatch', callback_data: `pm:disp:${order.id}` }]] },
      });
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
    await ctx.bot.sendMessage(paid.customer_telegram_id, '✅ Payment confirmed! Finding you a LEGO expert now…');
  } catch {
    /* ignore */
  }
  for (const adminId of config.adminIds) {
    try {
      await ctx.bot.sendMessage(adminId, `✅ Booking ${booking.id} paid (${auto ? 'auto' : 'manual'}); experts notified.`);
    } catch {
      /* ignore */
    }
  }
  await notifyExpertsOfBooking(ctx, paid);
  return true;
}

// Manual admin override (static path, or if the watcher misses).
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

// Admin accepts a paid order → dispatch the courier.
// Uber Direct auto-dispatch is not wired yet (needs merchant credentials), so
// for now we mark dispatched and hand the admin the delivery details.
export async function adminDispatch(ctx, chatId, telegramId, orderId) {
  if (!isAdminId(telegramId)) {
    await ctx.bot.sendMessage(chatId, 'Admins only.');
    return;
  }
  const o = await markOrderDispatched(orderId);
  if (!o) {
    await ctx.bot.sendMessage(chatId, 'That order isn’t in a paid/dispatchable state.');
    return;
  }

  await ctx.bot.sendMessage(
    chatId,
    `🚚 *Dispatching ${o.qty} × ${o.sku}*\n📍 ${o.delivery_address}\n📞 ${o.contact_phone || '—'}\n\n` +
      `Request a courier to this address and it’s on its way.`,
    { parse_mode: 'Markdown' }
  );
  try {
    await ctx.bot.sendMessage(o.telegram_id, '🚚 Your order is out for delivery!');
  } catch {
    /* ignore */
  }
}
