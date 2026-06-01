import { config } from '../config.js';
import {
  getUserByTelegramId,
  getUserById,
  listOpenBookings,
  acceptOpenBooking,
  getBooking,
  listExperts,
  setUserAddress,
} from '../supabase.js';
import { estimateBetween } from '../uber.js';
import { expertJobKeyboard } from '../lib/keyboards.js';
import { usd, fmtHourRange } from '../lib/format.js';

async function ensureExpert(ctx, chatId, telegramId) {
  const user = await getUserByTelegramId(telegramId);
  if (!user || (user.role !== 'expert' && user.role !== 'admin')) {
    await ctx.bot.sendMessage(chatId, 'This area is for SF Brick Co builders only.');
    return null;
  }
  if (!user.active) {
    await ctx.bot.sendMessage(chatId, 'Your builder account is currently inactive.');
    return null;
  }
  return user;
}

// Card for an open job, showing the travel estimate from THIS builder's address.
async function openJobCard(booking, builder) {
  let costLine;
  if (!builder.address) {
    costLine = '\n⚠️ Set your base address (📍 Update my address) to price + accept.';
  } else {
    const est = await estimateBetween(builder.address, booking.customer_address);
    costLine = est.ok
      ? `\n🚕 Travel from you ≈ ${usd(est.surchargeCents)} (~${est.miles} mi)`
      : '\n🚕 Travel: couldn’t estimate (a flat fee will apply)';
  }
  return (
    `🛠️ *Open job*\n` +
    `🕑 ${fmtHourRange(booking.slot_start, booking.slot_end)}\n` +
    `📍 ${booking.customer_address}\n` +
    `💵 Service fee ${usd(booking.service_fee_cents)}${costLine}`
  );
}

// Builder self-service base address (origin for travel pricing).
export async function promptSetAddress(ctx, chatId, telegramId) {
  const user = await ensureExpert(ctx, chatId, telegramId);
  if (!user) return;
  ctx.sessions.set(chatId, { flow: 'expert', step: 'awaiting_builder_address' });
  const current = user.address ? `\nCurrent: ${user.address}` : '';
  await ctx.bot.sendMessage(
    chatId,
    `📍 Send your *base address* (where you start from). We use it to price travel to each job.${current}`,
    { parse_mode: 'Markdown' }
  );
}

export async function doSetAddress(ctx, chatId, telegramId, text) {
  ctx.sessions.delete(chatId);
  const updated = await setUserAddress(telegramId, String(text).trim());
  await ctx.bot.sendMessage(
    chatId,
    updated ? `✅ Base address saved: ${updated.address}` : 'Could not save your address.'
  );
}

export async function listJobs(ctx, chatId, telegramId) {
  const user = await ensureExpert(ctx, chatId, telegramId);
  if (!user) return;
  const open = await listOpenBookings();
  if (open.length === 0) {
    await ctx.bot.sendMessage(chatId, 'No open jobs right now. We’ll ping you when one comes in.');
    return;
  }
  for (const b of open) {
    await ctx.bot.sendMessage(chatId, await openJobCard(b, user), {
      parse_mode: 'Markdown',
      ...expertJobKeyboard(b.id),
    });
  }
}

export async function accept(ctx, chatId, telegramId, bookingId) {
  const user = await ensureExpert(ctx, chatId, telegramId);
  if (!user) return;
  if (!user.address) {
    await ctx.bot.sendMessage(
      chatId,
      '📍 Set your base address first (📍 Update my address) so we can price the travel.'
    );
    return;
  }
  const booking = await getBooking(bookingId);
  if (!booking || booking.status !== 'awaiting_acceptance') {
    await ctx.bot.sendMessage(chatId, 'That job is no longer open.');
    return;
  }
  const est = await estimateBetween(user.address, booking.customer_address);
  const surcharge = est.ok ? est.surchargeCents : config.uber.flatFallbackCents;
  const total = booking.service_fee_cents + surcharge;
  const accepted = await acceptOpenBooking(bookingId, user.id, {
    surchargeCents: surcharge,
    totalCents: total,
  });
  if (!accepted) {
    await ctx.bot.sendMessage(chatId, 'Too late — another builder grabbed that one.');
    return;
  }
  await ctx.bot.sendMessage(
    chatId,
    `✅ You took the job for ${fmtHourRange(accepted.slot_start, accepted.slot_end)}.\n` +
      `📍 ${accepted.customer_address}\nTravel ${usd(surcharge)}. Awaiting customer payment.`
  );
  try {
    await ctx.bot.sendMessage(
      accepted.customer_telegram_id,
      `🎉 A builder accepted your booking for ${fmtHourRange(accepted.slot_start, accepted.slot_end)}!\n` +
        `• Service: ${usd(accepted.service_fee_cents)}\n• Travel: ${usd(surcharge)}\n• *Total: ${usd(total)}*\nTap to pay:`,
      {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: `Pay ${usd(total)}`, callback_data: `book:pay:${bookingId}` }]] },
      }
    );
  } catch {
    /* ignore */
  }
}

export async function decline(ctx, chatId, _bookingId) {
  await ctx.bot.sendMessage(chatId, 'Skipped — it stays open for other builders.');
}

// Notify active builders of a new open job (each sees travel from their address).
export async function notifyExpertsOfOpenBooking(ctx, booking) {
  const experts = await listExperts({ activeOnly: true });
  for (const e of experts) {
    try {
      await ctx.bot.sendMessage(e.telegram_id, `📨 New open job:\n\n${await openJobCard(booking, e)}`, {
        parse_mode: 'Markdown',
        ...expertJobKeyboard(booking.id),
      });
    } catch {
      /* builder hasn't opened the bot */
    }
  }
}

export { getUserById, getBooking };
