import { isAdminId } from '../config.js';
import {
  getUserByTelegramId,
  setRole,
  setUserRate,
  setUserAddress,
  creditBalance,
  getBalance,
  listOrdersByTelegramId,
  listBookingsByCustomer,
  getOrder,
  getBooking,
  removeDemoData,
} from '../supabase.js';
import { confirmOrder, confirmBooking } from './payments.js';
import { usd, shortRef, fmtHourRange, orderItemsSummary } from '../lib/format.js';

// ── Test mode (owner-only) ───────────────────────────────────────────
// Lets the owner experience the bot from any role and simulate payments so the
// full flow can be exercised without spending real crypto. Owner access is
// gated on isAdminId (env), independent of DB role — so switching role here
// NEVER removes /owner access.

function guard(ctx, chatId, telegramId) {
  if (!isAdminId(telegramId)) {
    ctx.bot.sendMessage(chatId, 'Test mode is owner-only.');
    return false;
  }
  return true;
}

const ROLE_LABEL = { customer: '👤 Customer', expert: '🛠️ Builder', admin: '⚙️ Owner' };

export async function showTestMode(ctx, chatId, telegramId) {
  if (!guard(ctx, chatId, telegramId)) return;
  const user = await getUserByTelegramId(telegramId);
  const role = user?.role || 'customer';
  const balance = await getBalance(telegramId);
  await ctx.bot.sendMessage(
    chatId,
    '🧪 *Test mode*\n' +
      `You’re currently viewing as: *${ROLE_LABEL[role] || role}*\n` +
      `Test wallet balance: *${usd(balance)}*\n\n` +
      'Switch your view, then use /shop, /book, /builder or /owner to walk that role. ' +
      '“Simulate a payment” marks one of your own pending orders/bookings as paid and runs the *real* downstream flow (builder ping, bonuses, reviews) — no crypto needed.\n\n' +
      '_Note: /owner always works for you regardless of the view._',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '👤 View as Customer', callback_data: 'adm:test:cust' },
            { text: '🛠️ View as Builder', callback_data: 'adm:test:build' },
          ],
          [{ text: '⚙️ View as Owner', callback_data: 'adm:test:owner' }],
          [{ text: '💳 Simulate a payment', callback_data: 'adm:test:pay' }],
          [{ text: '💰 Top up test wallet +$100', callback_data: 'adm:test:wallet' }],
          [{ text: '🧹 Remove demo data (before launch)', callback_data: 'adm:test:clean' }],
          [{ text: '⬅️ Back to panel', callback_data: 'adm:menu' }],
        ],
      },
    }
  );
}

export async function setMode(ctx, chatId, telegramId, mode) {
  if (!guard(ctx, chatId, telegramId)) return;
  if (mode === 'expert') {
    // Provision the essentials so the owner is a fully bookable Administrator.
    const user = await getUserByTelegramId(telegramId);
    await setRole(telegramId, 'expert');
    if (user?.rate_cents == null) await setUserRate(telegramId, 4000);
    if (!user?.address) await setUserAddress(telegramId, '500 Howard St, San Francisco, CA 94105');
    await ctx.bot.sendMessage(
      chatId,
      '🛠️ Now viewing as *Builder*. Open /builder to set hours & see jobs. You’re also bookable in /book, so you can book yourself to test the full loop.',
      { parse_mode: 'Markdown' }
    );
  } else {
    await setRole(telegramId, mode);
    await ctx.bot.sendMessage(
      chatId,
      mode === 'admin'
        ? '⚙️ Now viewing as *Owner*. Full access — /owner, /builder, /shop, /book.'
        : '👤 Now viewing as *Customer*. Use /shop and /book. (/builder is hidden in this view; /owner still works for you.)',
      { parse_mode: 'Markdown' }
    );
  }
  await showTestMode(ctx, chatId, telegramId);
}

export async function topUpTestWallet(ctx, chatId, telegramId) {
  if (!guard(ctx, chatId, telegramId)) return;
  const balance = await creditBalance(telegramId, 10000, { kind: 'adjustment', refType: 'test', refId: null });
  await ctx.bot.sendMessage(chatId, `💰 Added *$100.00* test credit. Balance: *${usd(balance)}*.`, {
    parse_mode: 'Markdown',
  });
  await showTestMode(ctx, chatId, telegramId);
}

// List the owner's own unpaid orders + bookings with one-tap "mark paid" buttons.
export async function showSimPayments(ctx, chatId, telegramId) {
  if (!guard(ctx, chatId, telegramId)) return;
  const orders = (await listOrdersByTelegramId(telegramId, 10)).filter((o) => o.status === 'pending');
  const bookings = (await listBookingsByCustomer(telegramId, 10)).filter(
    (b) => b.payment_status === 'unpaid' && !['cancelled', 'declined'].includes(b.status)
  );
  if (!orders.length && !bookings.length) {
    await ctx.bot.sendMessage(
      chatId,
      'No pending payments. Start a /shop order or a /book booking up to the payment step, then come back here to simulate paying it.',
      { reply_markup: { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'adm:test' }]] } }
    );
    return;
  }
  const rows = [];
  for (const o of orders) {
    rows.push([
      {
        text: `✅ Order ${shortRef(o.id)} — ${orderItemsSummary(o)} (${usd(o.amount_cents + (o.delivery_fee_cents || 0))})`,
        callback_data: `adm:test:payo:${o.id}`,
      },
    ]);
  }
  for (const b of bookings) {
    rows.push([
      {
        text: `✅ Booking ${shortRef(b.id)} — ${fmtHourRange(b.slot_start, b.slot_end)} (${usd(b.total_cents)})`,
        callback_data: `adm:test:payb:${b.id}`,
      },
    ]);
  }
  rows.push([{ text: '⬅️ Back', callback_data: 'adm:test' }]);
  await ctx.bot.sendMessage(chatId, '💳 *Simulate a payment*\nTap one to mark it paid and run the real confirm flow:', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows },
  });
}

export async function simulateOrderPay(ctx, chatId, telegramId, orderId) {
  if (!guard(ctx, chatId, telegramId)) return;
  const order = await getOrder(orderId);
  if (!order || order.telegram_id !== telegramId || order.status !== 'pending') {
    await ctx.bot.sendMessage(chatId, 'That order can’t be simulated (not yours, or already paid).');
    return;
  }
  const ok = await confirmOrder(ctx, order, { auto: true });
  await ctx.bot.sendMessage(chatId, ok ? '✅ Simulated payment — order confirmed.' : 'Already confirmed.');
}

// Remove the seeded demo Administrators, their bookings/reviews/availability,
// and the seeded wallet balances. Mirrors src/db/seed_teardown.sql.
export async function cleanDemoData(ctx, chatId, telegramId) {
  if (!guard(ctx, chatId, telegramId)) return;
  const removed = await removeDemoData();
  await ctx.bot.sendMessage(
    chatId,
    removed
      ? `🧹 Demo data removed — ${removed} demo Administrator${removed === 1 ? '' : 's'} (and their bookings, reviews, availability) deleted; seeded wallet balances zeroed.`
      : '🧹 Nothing to clean — demo data was already removed.'
  );
}

export async function simulateBookingPay(ctx, chatId, telegramId, bookingId) {
  if (!guard(ctx, chatId, telegramId)) return;
  const booking = await getBooking(bookingId);
  if (!booking || booking.customer_telegram_id !== telegramId || booking.payment_status !== 'unpaid') {
    await ctx.bot.sendMessage(chatId, 'That booking can’t be simulated (not yours, or already paid).');
    return;
  }
  const ok = await confirmBooking(ctx, booking, { auto: true });
  await ctx.bot.sendMessage(chatId, ok ? '✅ Simulated payment — booking confirmed.' : 'Already confirmed.');
}
