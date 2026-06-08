import { isAdminId } from '../config.js';
import { usd, fmtHourRange, shortRef, orderItemsSummary } from '../lib/format.js';
import { orderTotalCents } from '../lib/money.js';
import {
  getUserByTelegramId,
  listOrdersByTelegramId,
  listBookingsByCustomer,
  getBalance,
  getOrder,
  getProduct,
  cancelOrder,
  cancelBookingById,
} from '../supabase.js';
import { presentOrderMethods, presentBookingMethods } from './payments.js';

export async function showHelp(ctx, chatId, telegramId) {
  const user = await getUserByTelegramId(telegramId);
  const lines = [
    '🧱 *SF Brick Company — Help*',
    '',
    'Custom 3D-printed accessories compatible with leading building-block brands, plus on-site build help in San Francisco. Pay in crypto or from your wallet balance.',
    '',
    '*Commands*',
    '/shop — browse & order parts',
    '/book — book on-site build help',
    '/wallet — add funds & check your balance',
    '/orders — your recent orders & bookings',
    '/help — show this message',
  ];
  if (user?.role === 'expert' || user?.role === 'admin') lines.push('/builder — Administrator portal');
  if (isAdminId(telegramId)) lines.push('/owner — owner panel');
  await ctx.bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
}

const ORDER_STATUS = {
  pending: '🕒 awaiting payment',
  paid: '✅ paid — preparing',
  accepted: '✅ paid — preparing',
  dispatched: '🚚 out for delivery',
  delivered: '📦 delivered',
  cancelled: '✖ cancelled',
  refunded: '↩️ refunded',
};

export async function showMyOrders(ctx, chatId, telegramId) {
  const [orders, bookings, balance] = await Promise.all([
    listOrdersByTelegramId(telegramId),
    listBookingsByCustomer(telegramId),
    getBalance(telegramId),
  ]);

  await ctx.bot.sendMessage(chatId, `💰 Wallet balance: *${usd(balance)}*  ·  /wallet to top up`, {
    parse_mode: 'Markdown',
  });

  if (!orders.length && !bookings.length) {
    await ctx.bot.sendMessage(chatId, 'No orders or bookings yet — tap /shop or /book to start.');
    return;
  }

  for (const o of orders) {
    const total = orderTotalCents(o);
    const text = `🧾 *${shortRef(o.id)}* — ${orderItemsSummary(o)}\n${ORDER_STATUS[o.status] || o.status} · ${usd(total)}`;
    const reply_markup =
      o.status === 'pending'
        ? {
            inline_keyboard: [
              [
                { text: '💳 Show payment', callback_data: `acct:payo:${o.id}` },
                { text: '✖ Cancel', callback_data: `acct:cano:${o.id}` },
              ],
            ],
          }
        : undefined;
    await ctx.bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup });
  }

  for (const b of bookings) {
    let status;
    if (b.payment_status === 'paid') status = '✅ paid — confirmed';
    else if (b.payment_status === 'refunded') status = '↩️ refunded';
    else if (b.status === 'awaiting_acceptance') status = '🕒 finding an Administrator';
    else status = '🕒 awaiting payment';
    const text = `🛠️ *${shortRef(b.id)}* — ${fmtHourRange(b.slot_start, b.slot_end)}\n${status} · ${usd(b.total_cents)}`;
    const canPay =
      b.payment_status === 'unpaid' && b.surcharge_source !== 'pending' && b.status === 'awaiting_payment';
    const canCancel =
      b.payment_status === 'unpaid' && ['awaiting_acceptance', 'awaiting_payment'].includes(b.status);
    const buttons = [];
    if (canPay) buttons.push({ text: '💳 Show payment', callback_data: `acct:payb:${b.id}` });
    if (canCancel) buttons.push({ text: '✖ Cancel', callback_data: `acct:canb:${b.id}` });
    const reply_markup = buttons.length ? { inline_keyboard: [buttons] } : undefined;
    await ctx.bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup });
  }
}

export async function cancelMyOrder(ctx, chatId, telegramId, orderId) {
  const order = await getOrder(orderId);
  if (!order || order.telegram_id !== telegramId) {
    await ctx.bot.sendMessage(chatId, 'Order not found.');
    return;
  }
  const cancelled = await cancelOrder(orderId);
  await ctx.bot.sendMessage(
    chatId,
    cancelled ? `✖ Order ${shortRef(orderId)} cancelled.` : 'That order can no longer be cancelled.'
  );
}

export async function cancelMyBooking(ctx, chatId, telegramId, bookingId) {
  const cancelled = await cancelBookingById(bookingId);
  await ctx.bot.sendMessage(
    chatId,
    cancelled
      ? `✖ Booking ${shortRef(bookingId)} cancelled — the slot is free again.`
      : 'That booking can no longer be cancelled (it may already be paid).'
  );
}

export async function showOrderPayment(ctx, chatId, orderId) {
  const order = await getOrder(orderId);
  if (!order || order.status !== 'pending') {
    await ctx.bot.sendMessage(chatId, 'That order is no longer awaiting payment.');
    return;
  }
  const product = await getProduct(order.sku);
  await presentOrderMethods(ctx, chatId, order, product);
}

export async function showBookingPayment(ctx, chatId, bookingId) {
  await presentBookingMethods(ctx, chatId, bookingId);
}
