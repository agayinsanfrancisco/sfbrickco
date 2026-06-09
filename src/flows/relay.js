import { getBooking, getUserById } from '../supabase.js';
import { shortRef } from '../lib/format.js';

// In-bot relay: customer ↔ Administrator message each other through the bot, so
// neither sees the other's real Telegram handle or phone (privacy + keeps the
// relationship on-platform). Only available once a booking is paid.

async function parties(bookingId) {
  const b = await getBooking(bookingId);
  if (!b || b.payment_status !== 'paid') return null;
  const admin = b.expert_id ? await getUserById(b.expert_id) : null;
  return { booking: b, customerId: b.customer_telegram_id, adminId: admin?.telegram_id ?? null };
}

const OTHER = { customer: 'Administrator', admin: 'customer' };

// Open a relay "compose" session. role = the sender's role for this booking.
export async function startRelay(ctx, chatId, telegramId, bookingId, role) {
  const p = await parties(bookingId);
  const targetId = p && (role === 'customer' ? p.adminId : p.customerId);
  if (!p || !targetId) {
    await ctx.bot.sendMessage(chatId, 'Messaging isn’t available for this booking right now.');
    return;
  }
  ctx.sessions.set(chatId, { flow: 'relay', step: 'messaging', data: { bookingId, role } });
  await ctx.bot.sendMessage(
    chatId,
    `💬 Type a message and I’ll pass it to your ${OTHER[role]} — your contact details stay private. ` +
      `Send /start when you’re done.`
  );
}

// A composed message → forward to the other party with a Reply button.
export async function relayMessage(ctx, chatId, telegramId, text) {
  const s = ctx.sessions.get(chatId);
  if (s?.flow !== 'relay' || s.step !== 'messaging') return;
  const { bookingId, role } = s.data;
  const p = await parties(bookingId);
  const toId = p && (role === 'customer' ? p.adminId : p.customerId);
  if (!p || !toId) {
    ctx.sessions.delete(chatId);
    await ctx.bot.sendMessage(chatId, 'That booking is no longer active — messaging closed.');
    return;
  }
  // The recipient replies as the opposite role.
  const replyRole = role === 'customer' ? 'admin' : 'customer';
  try {
    await ctx.bot.sendMessage(
      toId,
      `💬 Message from your ${OTHER[role]} (booking ${shortRef(bookingId)}):\n\n${text}`,
      { reply_markup: { inline_keyboard: [[{ text: '💬 Reply', callback_data: `relay:${replyRole}:${bookingId}` }]] } }
    );
    await ctx.bot.sendMessage(chatId, '✅ Sent. Type another message, or /start to stop.');
  } catch {
    await ctx.bot.sendMessage(chatId, 'Couldn’t deliver that — they may not have the bot open right now.');
  }
}
