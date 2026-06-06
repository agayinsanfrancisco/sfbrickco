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
  getUserById,
} from '../supabase.js';

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

function isExpired(iso) {
  return iso ? Date.parse(iso) <= Date.now() : false;
}

function fmtClock(iso) {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'short',
  });
}

async function sendCryptoInstructions(
  ctx,
  chatId,
  { coin, address, amountCents, cryptoAmount, auto, expiresAt, kind, ref }
) {
  const c = crypto.COINS[coin];
  const tail = auto
    ? 'We’ll confirm automatically once it’s on-chain (usually a few minutes).'
    : 'Once sent, tap *“I’ve sent it”* and we’ll confirm shortly.';
  const expiryNote = expiresAt ? `\n⏳ Rate locked until *${fmtClock(expiresAt)}* — send promptly.` : '';
  const caption =
    `Send exactly *${cryptoAmount} ${c.ticker}* (≈ ${usd(amountCents)}) to:\n\n` +
    `\`${address}\`\n\n${tail}${expiryNote}`;
  const rows = [];
  if (!auto) rows.push([{ text: '✅ I’ve sent it', callback_data: `pm:sent:${kind}:${ref}` }]);
  rows.push([{ text: '🔄 Refresh quote', callback_data: `pm:re:${kind}:${coin}:${ref}` }]);
  const reply_markup = { inline_keyboard: rows };
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

export async function payOrderCrypto(ctx, chatId, telegramId, coin, orderId, { refresh = false } = {}) {
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

  // Double-tap / re-show guard: if a still-valid address was already issued for
  // this coin and we're not explicitly refreshing, re-show it instead of
  // burning a new derivation index.
  if (!refresh && order.pay_address && order.pay_coin === coin && !isExpired(order.pay_expires_at)) {
    await sendCryptoInstructions(ctx, chatId, {
      coin,
      address: order.pay_address,
      amountCents: total,
      cryptoAmount: order.crypto_amount,
      auto: crypto.hasXpub(coin),
      expiresAt: order.pay_expires_at,
      kind: 'o',
      ref: orderId,
    });
    return;
  }

  let amount, rate;
  try {
    ({ amount, rate } = await crypto.quoteWithRate(coin, total));
  } catch {
    await ctx.bot.sendMessage(chatId, '⚠️ Couldn’t fetch the exchange rate. Please try again shortly.');
    return;
  }
  const { address, index, auto } = await allocateAddress(coin);
  const payExpiresAt = new Date(Date.now() + config.crypto.quoteTtlMs).toISOString();
  await updateOrderCrypto(orderId, {
    paymentMethod: coin,
    cryptoAmount: amount,
    payCoin: coin,
    payAddress: auto ? address : null,
    payIndex: index,
    payExpiresAt,
    usdRate: rate,
  });
  await sendCryptoInstructions(ctx, chatId, {
    coin,
    address,
    amountCents: total,
    cryptoAmount: amount,
    auto,
    expiresAt: payExpiresAt,
    kind: 'o',
    ref: orderId,
  });
  if (!refresh) {
    await notifyAdminsToConfirm(ctx, {
      kind: 'o',
      ref: orderId,
      address,
      coin,
      amountCents: total,
      cryptoAmount: amount,
      detail: `Order: ${order.qty} × ${product?.name || order.sku} → ${order.delivery_address}`,
      auto,
    });
  }
}

export async function payBookingCrypto(ctx, chatId, telegramId, coin, bookingId, { refresh = false } = {}) {
  if (!crypto.isCoinAvailable(coin)) {
    await ctx.bot.sendMessage(chatId, 'That coin isn’t available right now.');
    return;
  }
  const booking = await getBooking(bookingId);
  if (!booking || booking.surcharge_source === 'pending' || booking.payment_status !== 'unpaid') {
    await ctx.bot.sendMessage(chatId, 'That booking isn’t ready for payment yet.');
    return;
  }

  if (!refresh && booking.pay_address && booking.pay_coin === coin && !isExpired(booking.pay_expires_at)) {
    await sendCryptoInstructions(ctx, chatId, {
      coin,
      address: booking.pay_address,
      amountCents: booking.total_cents,
      cryptoAmount: booking.crypto_amount,
      auto: crypto.hasXpub(coin),
      expiresAt: booking.pay_expires_at,
      kind: 'b',
      ref: bookingId,
    });
    return;
  }

  let amount, rate;
  try {
    ({ amount, rate } = await crypto.quoteWithRate(coin, booking.total_cents));
  } catch {
    await ctx.bot.sendMessage(chatId, '⚠️ Couldn’t fetch the exchange rate. Please try again shortly.');
    return;
  }
  const { address, index, auto } = await allocateAddress(coin);
  const payExpiresAt = new Date(Date.now() + config.crypto.quoteTtlMs).toISOString();
  await setBookingCrypto(bookingId, {
    paymentMethod: coin,
    cryptoAmount: amount,
    payCoin: coin,
    payAddress: auto ? address : null,
    payIndex: index,
    payExpiresAt,
    usdRate: rate,
  });
  await sendCryptoInstructions(ctx, chatId, {
    coin,
    address,
    amountCents: booking.total_cents,
    cryptoAmount: amount,
    auto,
    expiresAt: payExpiresAt,
    kind: 'b',
    ref: bookingId,
  });
  if (!refresh) {
    await notifyAdminsToConfirm(ctx, {
      kind: 'b',
      ref: bookingId,
      address,
      coin,
      amountCents: booking.total_cents,
      cryptoAmount: amount,
      detail: `Booking: ${fmtHourRange(booking.slot_start, booking.slot_end)} @ ${booking.customer_address}`,
      auto,
    });
  }
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
  if (!paid) return false; // already confirmed
  const when = fmtHourRange(paid.slot_start, paid.slot_end);
  try {
    await ctx.bot.sendMessage(paid.customer_telegram_id, `✅ Payment confirmed! Your builder is booked for ${when}.`);
  } catch {
    /* ignore */
  }
  // Notify the assigned builder that their job is paid/confirmed.
  if (paid.expert_id) {
    const builder = await getUserById(paid.expert_id);
    if (builder) {
      try {
        await ctx.bot.sendMessage(
          builder.telegram_id,
          `💰 Payment received — your job for ${when} at ${paid.customer_address} is confirmed.`
        );
      } catch {
        /* ignore */
      }
    }
  }
  for (const adminId of config.adminIds) {
    try {
      await ctx.bot.sendMessage(adminId, `✅ Booking ${booking.id} paid (${auto ? 'auto' : 'manual'}) & confirmed.`);
    } catch {
      /* ignore */
    }
  }
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
