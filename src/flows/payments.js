import { config, isAdminId } from '../config.js';
import { issueTermsToken, hasViewedTerms } from '../lib/termsgate.js';
import { notifyStaff } from '../lib/notify.js';
import { getIntSetting } from '../lib/settings.js';
import * as crypto from '../crypto.js';
import { usd, fmtHourRange, shortRef, orderItemsSummary, mdEscape } from '../lib/format.js';
import { orderTotalCents, discountFor } from '../lib/money.js';
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
  bookingByLinkedOrder,
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
  '• To the maximum extent permitted by law, SF Brick Company, @redbluebrick\\_bot, and their owners and operators disclaim *all liability*, and you agree to *indemnify and hold them harmless* from any claim, damage, or expense arising from your order.\n' +
  '• You are at least 18 years old and agree to our Terms.\n\n' +
  'Do you agree?';

const WAIVER_BOOKING =
  '⚠️ *Before you pay — please read carefully*\n\n' +
  'By tapping *“I agree”* you acknowledge and agree that:\n' +
  '• Block Experts are *independent third-party contractors*. They are NOT employees, agents, partners, or affiliates of SF Brick Company, @redbluebrick\\_bot, or their owners/operators, who act solely as a venue connecting you with the Block Expert and are not a party to, and bear no responsibility for, the session or the Block Expert’s conduct.\n' +
  '• You assume *all risks* of an in-person, on-site session — including any bodily injury, property damage, theft, or loss — whether arising from negligence or otherwise.\n' +
  '• The service is provided *“AS IS”*. To the maximum extent permitted by law, SF Brick Company and its owners/operators disclaim *all liability* and all warranties, and you agree to *indemnify, defend, and hold them harmless* from any and all claims, damages, or expenses arising from your booking.\n' +
  '• You are at least 18, you authorize entry to the address you provided, and you enter this agreement knowingly and voluntarily.\n\n' +
  'Do you agree?';

// Full legal text for the 📄 Terms buttons on review/confirm cards.
export function waiverText(kind) {
  return kind === 'b' ? WAIVER_BOOKING : WAIVER_ORDER;
}

export async function presentWaiver(ctx, chatId, kind, ref) {
  const url = `${config.server.publicUrl}/terms/${kind}?k=${issueTermsToken(chatId)}`;
  await ctx.bot.sendMessage(
    chatId,
    `⚠️ *Before you pay* — open and read the ${kind === 'b' ? 'booking' : 'sale'} terms, then tap “I agree”.`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: `📄 Read the ${kind === 'b' ? 'booking' : 'sale'} terms`, url }],
          [{ text: '✅ I agree — continue to payment', callback_data: `pm:agree:${kind}:${ref}` }],
          [{ text: '✖ No, cancel', callback_data: `pm:agreeno:${kind}:${ref}` }],
        ],
      },
    }
  );
}

export async function acceptWaiver(ctx, chatId, telegramId, kind, ref) {
  if (!hasViewedTerms(chatId)) {
    await ctx.bot.sendMessage(chatId, '☝️ Please open the 📄 terms link first — then tap “I agree” again.');
    return;
  }
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
    // Combined payment: this order rides on a booking's payment — show the
    // single combined charge instead of a separate order payment.
    const host = await bookingByLinkedOrder(ref);
    if (host) {
      await presentBookingMethods(ctx, chatId, host.id);
      return;
    }
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

// Combined charge: a booking plus any linked upsell parts order — paid in ONE
// payment. Returns the full amount due and the linked order (if any, still
// pending).
async function bookingCharge(booking) {
  if (!booking.linked_order_id) return { totalCents: booking.total_cents, linkedOrder: null };
  const order = await getOrder(booking.linked_order_id);
  if (!order || order.status !== 'pending') return { totalCents: booking.total_cents, linkedOrder: null };
  return { totalCents: booking.total_cents + orderTotalCents(order), linkedOrder: order };
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
  const { totalCents, linkedOrder } = await bookingCharge(booking);
  const rows = [];
  const balance = await getBalance(booking.customer_telegram_id);
  if (balance >= totalCents) {
    rows.push([{ text: `💰 Pay from balance (${usd(balance)})`, callback_data: `pm:bal:b:${bookingId}` }]);
  }
  rows.push(...methodButtons('b', bookingId));
  if (!rows.length) {
    await ctx.bot.sendMessage(chatId, '💳 Payments aren’t live yet — please check back soon!');
    return;
  }
  const breakdown = linkedOrder
    ? ` (${usd(booking.total_cents)} session + ${usd(orderTotalCents(linkedOrder))} bricks — one payment covers both)`
    : '';
  await ctx.bot.sendMessage(
    chatId,
    `🧾 Total *${usd(totalCents)}* for ${fmtHourRange(booking.slot_start, booking.slot_end)}${breakdown}\nChoose how to pay:`,
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
  await notifyStaff(ctx, 'manage_orders',
    `${head}\n${detail}\nExpect *${cryptoAmount} ${c.ticker}* (≈ ${usd(amountCents)}).\n${note}`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
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
      detail: `Order: ${orderItemsSummary(order)} → ${order.delivery_address}`,
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
  const { totalCents } = await bookingCharge(booking);

  if (!refresh && booking.pay_address && booking.pay_coin === coin && !isExpired(booking.pay_expires_at)) {
    await sendCryptoInstructions(ctx, chatId, {
      coin,
      address: booking.pay_address,
      amountCents: totalCents,
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
    ({ amount, rate } = await crypto.quoteWithRate(coin, totalCents));
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
    amountCents: totalCents,
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
      amountCents: totalCents,
      cryptoAmount: amount,
      detail: `Booking: ${fmtHourRange(booking.slot_start, booking.slot_end)} @ ${booking.customer_address}`,
      auto,
    });
  }
}

export async function customerSent(ctx, chatId, kind, ref) {
  await ctx.bot.sendMessage(chatId, '🙏 Thanks! We’ll verify the payment and confirm shortly.');
  await notifyStaff(ctx, 'manage_orders',
    `🔔 Customer reports they sent payment (${kind === 'o' ? 'order' : 'booking'} ${ref}). Verify + confirm.`);
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
  const { totalCents: total } = await bookingCharge(booking);
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

  // NOTE: the wallet bonus is no longer paid on the order. Buying a qualifying
  // 6-pack only *unlocks* eligibility; the bonus (a % of the deposit, capped,
  // first deposit only) is credited when the customer tops up their wallet —
  // see settleDeposit() in watcher.js.

  // Decrement stock per line item (cart) or the single SKU; deactivate + alert
  // admins on any item hitting zero (#14, #17).
  const lines = order.items?.length ? order.items : [{ sku: order.sku, qty: order.qty, name: order.sku }];
  for (const line of lines) {
    const remaining = await decrementStock(line.sku, line.qty);
    if (remaining && remaining.stock_qty === 0) {
      await setProductActive(line.sku, false);
      await notifyStaff(ctx, 'manage_orders',
        `⚠️ *${remaining.name || line.sku}* is now *sold out* and has been hidden from the shop. Restock via the dashboard or /owner.`,
        { parse_mode: 'Markdown' });
    } else if (remaining && remaining.reorder_floor > 0 && remaining.stock_qty <= remaining.reorder_floor) {
      // Low-stock reorder floor: warn once as stock crosses the threshold.
      await notifyStaff(ctx, 'manage_orders',
        `📉 *Low stock:* ${remaining.name || line.sku} down to *${remaining.stock_qty}* (reorder at ${remaining.reorder_floor}).`,
        { parse_mode: 'Markdown' });
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
    ? order.items.map((i) => `${i.qty}× ${mdEscape(i.name)}`).join(', ')
    : `${order.qty} × ${mdEscape(order.sku)}`;
  const detail =
    `📦 *Paid order ${shortRef(order.id)} — ready to dispatch*\n` +
    `${itemSummary}\n` +
    `📍 ${mdEscape(order.delivery_address)}\n` +
    `📞 ${mdEscape(order.contact_phone) || '—'}${order.contact_handle ? ` (@${mdEscape(order.contact_handle)})` : ''}` +
    `${order.notes ? `\n📝 ${mdEscape(order.notes)}` : ''}\n` +
    `Delivery fee ${usd(order.delivery_fee_cents)} · paid ${auto ? 'auto/on-chain' : 'manual'}`;
  await notifyStaff(ctx, 'manage_orders', detail, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '🚚 Accept & dispatch', callback_data: `pm:disp:${order.id}` }]] },
  });
  return true;
}

export async function confirmBooking(ctx, booking, { auto = false } = {}) {
  const paid = await markBookingPaid(booking.id);
  if (!paid) return false; // already confirmed
  // Combined payment: the booking's payment also covered a linked parts order —
  // confirm it now (idempotent; no-op if it was somehow paid separately).
  if (paid.linked_order_id) {
    const linked = await getOrder(paid.linked_order_id);
    if (linked && linked.status === 'pending') await confirmOrder(ctx, linked, { auto });
  }
  const when = fmtHourRange(paid.slot_start, paid.slot_end);
  try {
    await ctx.bot.sendMessage(
      paid.customer_telegram_id,
      `✅ Payment confirmed! Your Block Expert is booked for ${when}.\n` +
        'Need to share gate codes or timing? Message them right here — your contact stays private.',
      { reply_markup: { inline_keyboard: [[{ text: '💬 Message your Block Expert', callback_data: `relay:b:customer:${paid.id}` }]] } }
    );
  } catch {
    /* ignore */
  }
  // Notify the assigned builder that their job is paid/confirmed. We DON'T share
  // the customer's phone or @handle — coordination happens through the in-bot
  // relay (privacy + keeps the booking on-platform). Just a first name so the
  // builder knows who they're meeting at the door.
  if (paid.expert_id) {
    const builder = await getUserById(paid.expert_id);
    if (builder) {
      const cust = await getUserByTelegramId(paid.customer_telegram_id);
      const firstName = cust?.full_name ? cust.full_name.split(' ')[0] : 'your customer';
      try {
        await ctx.bot.sendMessage(
          builder.telegram_id,
          `💰 Payment received — your job for ${when} at ${paid.customer_address} is confirmed.\n👤 ${firstName}` +
            `\n\nMessage ${firstName} right here to coordinate — their contact stays private, and off-platform bookings aren’t allowed per your agreement.`,
          { reply_markup: { inline_keyboard: [[{ text: '💬 Message your customer', callback_data: `relay:b:admin:${paid.id}` }]] } }
        );
      } catch {
        /* ignore */
      }
    }
  }
  await notifyStaff(ctx, 'manage_experts', `✅ Booking ${shortRef(booking.id)} paid (${auto ? 'auto' : 'manual'}) & confirmed.`);
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
    `🚚 *Dispatching ${shortRef(o.id)} — ${mdEscape(orderItemsSummary(o))}*\n📍 ${mdEscape(o.delivery_address)}\n📞 ${mdEscape(o.contact_phone) || '—'}` +
      `${o.notes ? `\n📝 ${mdEscape(o.notes)}` : ''}\n\nRequest a courier to this address and it’s on its way.`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📬 Mark delivered', callback_data: `pm:deliv:${o.id}` }],
          [{ text: '💬 Message the customer', callback_data: `relay:o:admin:${o.id}` }],
        ],
      },
    }
  );
  try {
    await ctx.bot.sendMessage(o.telegram_id, '🚚 Your order is out for delivery!', {
      reply_markup: {
        inline_keyboard: [[{ text: '💬 Message us about delivery', callback_data: `relay:o:customer:${o.id}` }]],
      },
    });
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
