import { config, isAdminId } from '../config.js';
import * as crypto from '../crypto.js';
import { usd, fmtHourRange, shortRef, orderItemsSummary } from '../lib/format.js';
import { orderTotalCents, discountFor } from '../lib/money.js';
import { getIntSetting } from '../lib/settings.js';
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
  getUserByTelegramId,
  getBalance,
  debitBalance,
  creditBalance,
  setProductActive,
  markOrderDelivered,
  logEvent,
  getPromo,
  redeemPromo,
  setOrderPromo,
  recordOrderWaiver,
  recordBookingWaiver,
  hasReceivedBonus,
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

// ── Checkout waiver (must accept before any payment) ─────────────────
const WAIVER_ORDER =
  '⚠️ *Before you pay — please read carefully*\n\n' +
  'By tapping *“I agree”* you acknowledge and agree that:\n' +
  '• Our parts are independent, third-party accessories, sold strictly *“AS IS”* and *“AS AVAILABLE”* with no warranties of any kind, express or implied (including merchantability or fitness for a particular purpose).\n' +
  '• You assume *all risks* arising from the purchase, handling, and use of the parts, including choking or other hazards, injury, property damage, or loss.\n' +
  '• To the maximum extent permitted by law, SF Brick Company, @redbluebrick_bot, and their owners and operators disclaim *all liability*, and you agree to *indemnify and hold them harmless* from any claim, damage, or expense arising from your order.\n' +
  '• You are at least 18 years old and agree to our Terms.\n\n' +
  'Do you agree?';

const WAIVER_BOOKING =
  '⚠️ *Before you pay — please read carefully*\n\n' +
  'By tapping *“I agree”* you acknowledge and agree that:\n' +
  '• Administrators are *independent third-party contractors*. They are NOT employees, agents, partners, or affiliates of SF Brick Company, @redbluebrick_bot, or their owners/operators, who act solely as a venue connecting you with the Administrator and are not a party to, and bear no responsibility for, the session or the Administrator’s conduct.\n' +
  '• You assume *all risks* of an in-person, on-site session — including any bodily injury, property damage, theft, or loss — whether arising from negligence or otherwise.\n' +
  '• The service is provided *“AS IS”*. To the maximum extent permitted by law, SF Brick Company and its owners/operators disclaim *all liability* and all warranties, and you agree to *indemnify, defend, and hold them harmless* from any and all claims, damages, or expenses arising from your booking.\n' +
  '• You are at least 18, you authorize entry to the address you provided, and you enter this agreement knowingly and voluntarily.\n\n' +
  'Do you agree?';

export async function presentWaiver(ctx, chatId, kind, ref) {
  await ctx.bot.sendMessage(chatId, kind === 'b' ? WAIVER_BOOKING : WAIVER_ORDER, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ I agree — continue to payment', callback_data: `pm:agree:${kind}:${ref}` }],
        [{ text: '✖ No, cancel', callback_data: `pm:agreeno:${kind}:${ref}` }],
      ],
    },
  });
}

export async function acceptWaiver(ctx, chatId, telegramId, kind, ref) {
  if (kind === 'b') {
    const booking = await getBooking(ref);
    if (!booking) {
      await ctx.bot.sendMessage(chatId, 'That booking could not be found.');
      return;
    }
    await recordBookingWaiver(ref);
    await presentBookingMethods(ctx, chatId, ref);
  } else {
    const order = await getOrder(ref);
    if (!order || order.status !== 'pending') {
      await ctx.bot.sendMessage(chatId, 'That order is no longer awaiting payment.');
      return;
    }
    await recordOrderWaiver(ref);
    await presentOrderMethods(ctx, chatId, order, null);
  }
}

export async function declineWaiver(ctx, chatId, _kind, _ref) {
  await ctx.bot.sendMessage(chatId, 'No problem — you were not charged. Tap /start whenever you’re ready.');
}

// Order row already created (with delivery + contact). Show totals + methods.
export async function presentOrderMethods(ctx, chatId, order, product) {
  const total = orderTotalCents(order);
  const rows = [];
  const balance = await getBalance(order.telegram_id);
  if (balance >= total) {
    rows.push([{ text: `💰 Pay from balance (${usd(balance)})`, callback_data: `pm:bal:o:${order.id}` }]);
  }
  rows.push(...methodButtons('o', order.id));
  if (!order.promo_code) {
    rows.push([{ text: '🏷️ Have a promo code?', callback_data: `pm:promo:${order.id}` }]);
  }
  if (!rows.length) {
    await ctx.bot.sendMessage(chatId, '🛒 Payments aren’t live yet — please check back soon!');
    return;
  }
  const discountLine = order.discount_cents
    ? `\n• Discount${order.promo_code ? ` (${order.promo_code})` : ''}: −${usd(order.discount_cents)}`
    : '';
  const header = order.items?.length
    ? `🧾 *Order ${shortRef(order.id)}*\n${order.items.map((i) => `• ${i.qty}× ${i.name}`).join('\n')}`
    : `🧾 *${order.qty} × ${product?.name || order.sku}*`;
  await ctx.bot.sendMessage(
    chatId,
    `${header}\n` +
      `• Items: ${usd(order.amount_cents)}\n` +
      `• Courier delivery: ${usd(order.delivery_fee_cents)}${discountLine}\n` +
      `• *Total: ${usd(total)}*\nChoose how to pay:`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } }
  );
}

// Promo: prompt for a code, validate + redeem, store the discount, re-present.
export async function promptPromo(ctx, chatId, orderId) {
  ctx.sessions.set(chatId, { flow: 'promo', step: 'awaiting_code', data: { orderId } });
  await ctx.bot.sendMessage(chatId, '🏷️ Send your promo code (or /start to skip):');
}

export async function applyPromo(ctx, chatId, code) {
  const session = ctx.sessions.get(chatId);
  const orderId = session?.data?.orderId;
  ctx.sessions.delete(chatId);
  if (!orderId) return;
  const order = await getOrder(orderId);
  if (!order || order.status !== 'pending') {
    await ctx.bot.sendMessage(chatId, 'That order is no longer awaiting payment.');
    return;
  }
  if (order.promo_code) {
    await ctx.bot.sendMessage(chatId, 'A code is already applied to this order.');
    return;
  }
  const promo = await getPromo(code);
  if (!promo || !promo.active) {
    await ctx.bot.sendMessage(chatId, '❌ That code isn’t valid. Choose how to pay:');
    return presentOrderMethods(ctx, chatId, order, await getProduct(order.sku));
  }
  const discount = discountFor(order.amount_cents, promo);
  const redeemed = await redeemPromo(code); // atomic: respects active + max_uses
  if (!redeemed) {
    await ctx.bot.sendMessage(chatId, '❌ That code is no longer available.');
    return presentOrderMethods(ctx, chatId, order, await getProduct(order.sku));
  }
  const updated = await setOrderPromo(orderId, { code: redeemed.code, discountCents: discount });
  await ctx.bot.sendMessage(chatId, `✅ Code applied — ${usd(discount)} off.`);
  await presentOrderMethods(ctx, chatId, updated || order, await getProduct(order.sku));
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
  const rows = [];
  const balance = await getBalance(booking.customer_telegram_id);
  if (balance >= booking.total_cents) {
    rows.push([{ text: `💰 Pay from balance (${usd(balance)})`, callback_data: `pm:bal:b:${bookingId}` }]);
  }
  rows.push(...methodButtons('b', bookingId));
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

// Stock check that understands both single-item and multi-item (cart) orders.
async function stockOk(order) {
  if (order.items?.length) {
    for (const it of order.items) {
      const p = await getProduct(it.sku);
      if ((p?.stock_qty ?? 0) < it.qty) return false;
    }
    return true;
  }
  const p = await getProduct(order.sku);
  return (p?.stock_qty ?? 0) >= order.qty;
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
  if (!(await stockOk(order))) {
    await ctx.bot.sendMessage(chatId, '😔 An item is no longer in stock. Please start a new order.');
    return;
  }
  const total = orderTotalCents(order);

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

// ── Pay from prepaid wallet balance ──────────────────────────────────
export async function payOrderFromBalance(ctx, chatId, telegramId, orderId) {
  const order = await getOrder(orderId);
  if (!order || order.status !== 'pending') {
    await ctx.bot.sendMessage(chatId, 'That order is no longer awaiting payment.');
    return;
  }
  if (!(await stockOk(order))) {
    await ctx.bot.sendMessage(chatId, '😔 An item is no longer in stock. Please start a new order.');
    return;
  }
  const total = orderTotalCents(order);
  const newBalance = await debitBalance(order.telegram_id, total, { refType: 'order', refId: order.id });
  if (newBalance === null) {
    await ctx.bot.sendMessage(chatId, 'Your balance no longer covers this. Tap /wallet to top up.');
    return;
  }
  const ok = await confirmOrder(ctx, order, { auto: false });
  if (!ok) {
    // Already paid (e.g. watcher race) — refund the debit so nothing is lost.
    await creditBalance(order.telegram_id, total, { kind: 'refund', refType: 'order', refId: order.id });
    await ctx.bot.sendMessage(chatId, 'That order was already paid — your balance wasn’t charged.');
    return;
  }
  await ctx.bot.sendMessage(chatId, `💰 Paid ${usd(total)} from your balance. Remaining: ${usd(newBalance)}.`);
}

export async function payBookingFromBalance(ctx, chatId, telegramId, bookingId) {
  const booking = await getBooking(bookingId);
  if (!booking || booking.surcharge_source === 'pending' || booking.payment_status !== 'unpaid') {
    await ctx.bot.sendMessage(chatId, 'That booking isn’t ready for payment yet.');
    return;
  }
  const total = booking.total_cents;
  const newBalance = await debitBalance(booking.customer_telegram_id, total, {
    refType: 'booking',
    refId: booking.id,
  });
  if (newBalance === null) {
    await ctx.bot.sendMessage(chatId, 'Your balance no longer covers this. Tap /wallet to top up.');
    return;
  }
  const ok = await confirmBooking(ctx, booking, { auto: false });
  if (!ok) {
    await creditBalance(booking.customer_telegram_id, total, {
      kind: 'refund',
      refType: 'booking',
      refId: booking.id,
    });
    await ctx.bot.sendMessage(chatId, 'That booking was already paid — your balance wasn’t charged.');
    return;
  }
  await ctx.bot.sendMessage(chatId, `💰 Paid ${usd(total)} from your balance. Remaining: ${usd(newBalance)}.`);
}

// ── Fulfillment (shared by watcher + manual admin button) ────────────
export async function confirmOrder(ctx, order, { auto = false } = {}) {
  const paid = await markOrderPaid(order.id);
  if (!paid) return false; // already confirmed
  logEvent(order.telegram_id, 'order_paid', { id: order.id, total: orderTotalCents(order) });

  // Brick-buy wallet bonus (#incentive): contingent on a qualifying purchase and
  // only on the customer's FIRST one — never paid to non-buyers or repeat buyers.
  const bonusCents = await getIntSetting('brick_bonus_cents', 0);
  const bonusMin = await getIntSetting('brick_bonus_min_cents', 0);
  if (
    bonusCents > 0 &&
    (order.amount_cents || 0) >= bonusMin &&
    !(await hasReceivedBonus(order.telegram_id))
  ) {
    try {
      const bal = await creditBalance(order.telegram_id, bonusCents, {
        kind: 'bonus',
        refType: 'order',
        refId: order.id,
      });
      await ctx.bot.sendMessage(
        order.telegram_id,
        `🎁 You earned a *${usd(bonusCents)}* wallet bonus on this order! Balance: *${usd(bal)}*.`,
        { parse_mode: 'Markdown' }
      );
    } catch {
      /* ignore */
    }
  }
  // Decrement stock per line item (cart) or the single SKU; deactivate + alert
  // admins on any item hitting zero (#14, #17).
  const lines = order.items?.length ? order.items : [{ sku: order.sku, qty: order.qty, name: order.sku }];
  for (const line of lines) {
    const remaining = await decrementStock(line.sku, line.qty);
    if (remaining && remaining.stock_qty === 0) {
      await setProductActive(line.sku, false);
      for (const adminId of config.adminIds) {
        try {
          await ctx.bot.sendMessage(adminId, `⚠️ ${line.sku} is now *sold out* and has been hidden from the shop. Restock via the inventory menu.`, {
            parse_mode: 'Markdown',
          });
        } catch {
          /* ignore */
        }
      }
    }
  }
  try {
    await ctx.bot.sendMessage(
      order.telegram_id,
      '✅ Payment confirmed! We’re preparing your order for courier delivery.'
    );
  } catch {
    /* ignore */
  }
  const itemSummary = order.items?.length
    ? order.items.map((i) => `${i.qty}× ${i.name}`).join(', ')
    : `${order.qty} × ${order.sku}`;
  const detail =
    `📦 *Paid order ${shortRef(order.id)} — ready to dispatch*\n` +
    `${itemSummary}\n` +
    `📍 ${order.delivery_address}\n` +
    `📞 ${order.contact_phone || '—'}${order.contact_handle ? ` (@${order.contact_handle})` : ''}` +
    `${order.notes ? `\n📝 ${order.notes}` : ''}\n` +
    `Delivery fee ${usd(order.delivery_fee_cents)} · paid ${auto ? 'auto/on-chain' : 'manual'}`;
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
    await ctx.bot.sendMessage(paid.customer_telegram_id, `✅ Payment confirmed! Your Administrator is booked for ${when}.`);
  } catch {
    /* ignore */
  }
  // Notify the assigned builder that their job is paid/confirmed. Customer
  // contact (name + handle) is revealed only now, post-payment, so they can
  // coordinate the visit — not before payment.
  if (paid.expert_id) {
    const builder = await getUserById(paid.expert_id);
    if (builder) {
      const cust = await getUserByTelegramId(paid.customer_telegram_id);
      const contact = cust
        ? `\n👤 ${cust.full_name || 'Customer'}${cust.username ? ` (@${cust.username})` : ''}${
            paid.contact_phone ? ` · 📞 ${paid.contact_phone}` : ''
          }`
        : '';
      try {
        await ctx.bot.sendMessage(
          builder.telegram_id,
          `💰 Payment received — your job for ${when} at ${paid.customer_address} is confirmed.${contact}` +
            `\n\nPlease coordinate through SF Brick Company; per your agreement, off-platform bookings aren’t allowed.`
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
    `🚚 *Dispatching ${shortRef(o.id)} — ${orderItemsSummary(o)}*\n📍 ${o.delivery_address}\n📞 ${o.contact_phone || '—'}` +
      `${o.notes ? `\n📝 ${o.notes}` : ''}\n\nRequest a courier to this address and it’s on its way.`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '📬 Mark delivered', callback_data: `pm:deliv:${o.id}` }]] },
    }
  );
  try {
    await ctx.bot.sendMessage(o.telegram_id, '🚚 Your order is out for delivery!');
  } catch {
    /* ignore */
  }
}

// Admin marks an order delivered → notify the customer (#20).
export async function adminDelivered(ctx, chatId, telegramId, orderId) {
  if (!isAdminId(telegramId)) {
    await ctx.bot.sendMessage(chatId, 'Admins only.');
    return;
  }
  const o = await markOrderDelivered(orderId);
  if (!o) {
    await ctx.bot.sendMessage(chatId, 'That order isn’t in a dispatched state.');
    return;
  }
  await ctx.bot.sendMessage(chatId, `📬 ${shortRef(o.id)} marked delivered.`);
  try {
    await ctx.bot.sendMessage(o.telegram_id, '📬 Your order was delivered — enjoy! Tap /shop to order again.');
  } catch {
    /* ignore */
  }
}
