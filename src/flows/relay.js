import { config } from '../config.js';
import { getBooking, getUserById, getOrder } from '../supabase.js';
import { shortRef } from '../lib/format.js';

// In-bot relay: the two sides of a booking (customer ↔ Block Expert) or an
// order (customer ↔ store) message each other through the bot, so nobody's
// real Telegram handle or phone is exposed (privacy + keeps it on-platform).
// Bookings relay only once paid; orders relay once paid (dispatch coordination).

async function bookingParties(bookingId) {
  const b = await getBooking(bookingId);
  if (!b || b.payment_status !== 'paid') return null;
  const admin = b.expert_id ? await getUserById(b.expert_id) : null;
  return { customerId: b.customer_telegram_id, adminId: admin?.telegram_id ?? null };
}

async function orderParties(orderId) {
  const o = await getOrder(orderId);
  if (!o || !['paid', 'dispatched'].includes(o.status)) return null;
  // The "admin" side of an order relay is the store (all owner accounts).
  return { customerId: o.telegram_id, adminIds: config.adminIds };
}

const OTHER = { customer: 'Block Expert', admin: 'customer' };
const OTHER_ORDER = { customer: 'store', admin: 'customer' };

// Open a relay "compose" session. kind: 'b' (booking) | 'o' (order).
export async function startRelay(ctx, chatId, telegramId, kind, refId, role) {
  if (kind === 'b') {
    const p = await bookingParties(refId);
    const targetId = p && (role === 'customer' ? p.adminId : p.customerId);
    if (!p || !targetId) {
      await ctx.bot.sendMessage(chatId, 'Messaging isn’t available for this booking right now.');
      return;
    }
  } else {
    const p = await orderParties(refId);
    if (!p) {
      await ctx.bot.sendMessage(chatId, 'Messaging isn’t available for this order right now.');
      return;
    }
  }
  ctx.sessions.set(chatId, { flow: 'relay', step: 'messaging', data: { kind, refId, role } });
  const other = kind === 'b' ? OTHER[role] : OTHER_ORDER[role];
  await ctx.bot.sendMessage(
    chatId,
    `💬 Type a message and I’ll pass it to your ${other} — your contact details stay private. ` +
      `Send /start when you’re done.`
  );
}

// A composed message → forward to the other party with a Reply button.
export async function relayMessage(ctx, chatId, telegramId, text) {
  const s = ctx.sessions.get(chatId);
  if (s?.flow !== 'relay' || s.step !== 'messaging') return;
  const { kind, refId, role } = s.data;
  const replyRole = role === 'customer' ? 'admin' : 'customer';
  const replyBtn = (toRole) => ({
    reply_markup: { inline_keyboard: [[{ text: '💬 Reply', callback_data: `relay:${kind}:${toRole}:${refId}` }]] },
  });

  let targets = [];
  let fromLabel;
  if (kind === 'b') {
    const p = await bookingParties(refId);
    const toId = p && (role === 'customer' ? p.adminId : p.customerId);
    if (!p || !toId) {
      ctx.sessions.delete(chatId);
      await ctx.bot.sendMessage(chatId, 'That booking is no longer active — messaging closed.');
      return;
    }
    targets = [toId];
    fromLabel = `your ${OTHER[replyRole]} (booking ${shortRef(refId)})`;
  } else {
    const p = await orderParties(refId);
    if (!p) {
      ctx.sessions.delete(chatId);
      await ctx.bot.sendMessage(chatId, 'That order is no longer active — messaging closed.');
      return;
    }
    targets = role === 'customer' ? p.adminIds : [p.customerId];
    fromLabel =
      role === 'customer' ? `the customer (order ${shortRef(refId)})` : `the store (order ${shortRef(refId)})`;
  }

  let delivered = false;
  for (const toId of targets) {
    try {
      await ctx.bot.sendMessage(toId, `💬 Message from ${fromLabel}:\n\n${text}`, replyBtn(replyRole));
      delivered = true;
    } catch {
      /* recipient hasn't opened the bot */
    }
  }
  await ctx.bot.sendMessage(
    chatId,
    delivered ? '✅ Sent. Type another message, or /start to stop.' : 'Couldn’t deliver that right now.'
  );
}
