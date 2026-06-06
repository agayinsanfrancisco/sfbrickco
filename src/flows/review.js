import {
  getBooking,
  createReview,
  updateReviewComment,
  markReviewPrompted,
} from '../supabase.js';
import { ratingKeyboard } from '../lib/keyboards.js';
import { fmtHourRange } from '../lib/format.js';

// Sent by the scheduler once a booking's hour has passed.
export async function promptReview(ctx, booking) {
  try {
    await ctx.bot.sendMessage(
      booking.customer_telegram_id,
      `🧱 How was your build-help session (${fmtHourRange(
        booking.slot_start,
        booking.slot_end
      )})?\nTap a rating:`,
      ratingKeyboard(booking.id)
    );
  } catch {
    /* customer may have blocked the bot */
  } finally {
    await markReviewPrompted(booking.id);
  }
}

export async function rate(ctx, chatId, telegramId, bookingId, rating) {
  const booking = await getBooking(bookingId);
  if (!booking) return;
  await createReview({
    bookingId,
    customerTelegramId: telegramId,
    expertId: booking.expert_id,
    rating,
    comment: null,
  });
  // Hold booking id so a follow-up text becomes the comment.
  ctx.sessions.set(chatId, { flow: 'review', step: 'awaiting_comment', data: { bookingId } });
  await ctx.bot.sendMessage(
    chatId,
    `Thanks for the ${'⭐'.repeat(rating)}! Add a comment, or send /skip.`
  );
}

export async function addComment(ctx, chatId, telegramId, text) {
  const session = ctx.sessions.get(chatId);
  const bookingId = session?.data?.bookingId;
  ctx.sessions.delete(chatId);
  if (!bookingId) return;
  await updateReviewComment(bookingId, text);
  await ctx.bot.sendMessage(chatId, '🙏 Thanks for the feedback!');
}
