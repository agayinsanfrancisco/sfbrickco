import {
  getUserByTelegramId,
  getUserById,
  listPendingBookings,
  acceptBooking,
  getBooking,
} from '../supabase.js';
import { expertJobKeyboard } from '../lib/keyboards.js';
import { usd, fmtHourRange } from '../lib/format.js';

function bookingCard(b) {
  return (
    `🛠️ *Setup request*\n` +
    `🕑 ${fmtHourRange(b.slot_start, b.slot_end)}\n` +
    `📍 ${b.customer_address || '(address on file)'}\n` +
    `💵 Paid total ${usd(b.total_cents)} (your fee ${usd(b.service_fee_cents)} + travel ${usd(
      b.surcharge_cents
    )})`
  );
}

async function ensureExpert(ctx, chatId, telegramId) {
  const user = await getUserByTelegramId(telegramId);
  if (!user || (user.role !== 'expert' && user.role !== 'admin')) {
    await ctx.bot.sendMessage(chatId, 'This area is for LEGO experts only.');
    return null;
  }
  if (!user.active) {
    await ctx.bot.sendMessage(chatId, 'Your expert account is currently inactive.');
    return null;
  }
  return user;
}

export async function listJobs(ctx, chatId, telegramId) {
  const user = await ensureExpert(ctx, chatId, telegramId);
  if (!user) return;
  const pending = await listPendingBookings();
  if (pending.length === 0) {
    await ctx.bot.sendMessage(chatId, 'No open jobs right now. We’ll ping you when one comes in.');
    return;
  }
  for (const b of pending) {
    await ctx.bot.sendMessage(chatId, bookingCard(b), {
      parse_mode: 'Markdown',
      ...expertJobKeyboard(b.id),
    });
  }
}

export async function accept(ctx, chatId, telegramId, bookingId) {
  const user = await ensureExpert(ctx, chatId, telegramId);
  if (!user) return;
  const booking = await acceptBooking(bookingId, user.id);
  if (!booking) {
    await ctx.bot.sendMessage(chatId, 'Too late — another expert already grabbed that one.');
    return;
  }
  await ctx.bot.sendMessage(
    chatId,
    `✅ You’re booked for ${fmtHourRange(booking.slot_start, booking.slot_end)}.\n📍 ${
      booking.customer_address
    }`
  );
  // Let the customer know.
  await ctx.bot.sendMessage(
    booking.customer_telegram_id,
    `🎉 An expert accepted your booking for ${fmtHourRange(
      booking.slot_start,
      booking.slot_end
    )}. See you then!`
  );
}

export async function decline(ctx, chatId, bookingId) {
  // Per-expert decline just removes it from this expert's view; the booking
  // stays open for others.
  await ctx.bot.sendMessage(chatId, 'Skipped. It stays available for other experts.');
}

// Notify all active experts that a new paid booking is awaiting acceptance.
export async function notifyExpertsOfBooking(ctx, booking) {
  const { listExperts } = await import('../supabase.js');
  const experts = await listExperts({ activeOnly: true });
  for (const e of experts) {
    try {
      await ctx.bot.sendMessage(e.telegram_id, `📨 New job available:\n\n${bookingCard(booking)}`, {
        parse_mode: 'Markdown',
        ...expertJobKeyboard(booking.id),
      });
    } catch {
      // expert may have never started a chat with the bot; skip.
    }
  }
}

export { getUserById, getBooking };
