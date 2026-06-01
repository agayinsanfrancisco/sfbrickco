import { config } from '../config.js';
import { createBooking, slotTaken } from '../supabase.js';
import { estimateSurcharge } from '../uber.js';
import { upcomingDays, hourlySlots } from '../lib/slots.js';
import {
  daysKeyboard,
  hoursKeyboard,
  confirmBookingKeyboard,
} from '../lib/keyboards.js';
import { usd, fmtHourRange } from '../lib/format.js';
import { notifyAdminsForFare } from './admin.js';
import { presentBookingMethods } from './payments.js';

export async function startBooking(ctx, chatId) {
  const days = upcomingDays(7);
  await ctx.bot.sendMessage(
    chatId,
    `🛠️ *Book a LEGO expert*\n\n` +
      `Base fee ${usd(config.pricing.serviceFeeCents)} for a 1-hour on-site session, ` +
      `plus a travel surcharge (Uber from Civic Center to you).\n\nPick a day:`,
    { parse_mode: 'Markdown', ...daysKeyboard(days) }
  );
}

export async function pickDay(ctx, chatId, dateKey) {
  const slots = hourlySlots(dateKey);
  await ctx.bot.sendMessage(
    chatId,
    slots.length
      ? 'Pick a 1-hour start time (Pacific):'
      : 'No remaining slots that day — pick another.',
    hoursKeyboard(slots)
  );
}

export async function pickHour(ctx, chatId, startIso) {
  // Recompute end from start (+1h) rather than trusting client data.
  const endIso = new Date(new Date(startIso).getTime() + 60 * 60 * 1000).toISOString();
  if (await slotTaken(startIso)) {
    await ctx.bot.sendMessage(
      chatId,
      'Sorry, that hour was just taken. Please pick another time.'
    );
    return;
  }
  ctx.sessions.set(chatId, {
    flow: 'book',
    step: 'awaiting_address',
    data: { startIso, endIso },
  });
  await ctx.bot.sendMessage(
    chatId,
    'Great. What is the *full address* where you need setup help?\n' +
      '(Street, city, ZIP — used to estimate the Uber travel surcharge.)',
    { parse_mode: 'Markdown' }
  );
}

// Called from the text handler once we have the address in session.
export async function receiveAddress(ctx, chatId, telegramId, address) {
  const session = ctx.sessions.get(chatId);
  if (!session?.data?.startIso) {
    await ctx.bot.sendMessage(chatId, 'Let’s start over — tap "Book a LEGO expert".');
    ctx.sessions.delete(chatId);
    return;
  }
  const { startIso, endIso } = session.data;
  ctx.sessions.delete(chatId);

  const serviceFee = config.pricing.serviceFeeCents;
  const est = await estimateSurcharge(address); // option A

  if (est.ok) {
    const total = serviceFee + est.surchargeCents;
    const booking = await createBooking({
      customer_telegram_id: telegramId,
      customer_address: address,
      slot_start: startIso,
      slot_end: endIso,
      service_fee_cents: serviceFee,
      surcharge_cents: est.surchargeCents,
      surcharge_source: 'estimate',
      distance_miles: est.miles,
      total_cents: total,
    });
    await ctx.bot.sendMessage(
      chatId,
      `🧾 *Booking summary*\n` +
        `🕑 ${fmtHourRange(startIso, endIso)}\n` +
        `📍 ${address}\n\n` +
        `• Expert setup (1 hr): ${usd(serviceFee)}\n` +
        `• Travel surcharge (~${est.miles} mi est.): ${usd(est.surchargeCents)}\n` +
        `• *Total: ${usd(total)}*\n\n` +
        `Pay to send your request to our experts.`,
      { parse_mode: 'Markdown', ...confirmBookingKeyboard(booking.id) }
    );
    return;
  }

  // Option B: couldn't estimate → create with pending surcharge, ask an admin
  // to confirm the fare. Customer is told we'll follow up.
  const booking = await createBooking({
    customer_telegram_id: telegramId,
    customer_address: address,
    slot_start: startIso,
    slot_end: endIso,
    service_fee_cents: serviceFee,
    surcharge_cents: 0,
    surcharge_source: 'pending',
    total_cents: serviceFee,
  });
  await ctx.bot.sendMessage(
    chatId,
    `📍 We couldn’t auto-estimate the travel fare for that address.\n` +
      `A team member will confirm the Uber surcharge shortly, then send you a payment link. ` +
      `Your slot ${fmtHourRange(startIso, endIso)} is held pending confirmation.`
  );
  await notifyAdminsForFare(ctx, booking);
}

// Customer chose to pay → present available payment methods (card / crypto).
export async function payBooking(ctx, chatId, _telegramId, bookingId) {
  await presentBookingMethods(ctx, chatId, bookingId);
}

export function cancelBooking(ctx, chatId) {
  ctx.sessions.delete(chatId);
  return ctx.bot.sendMessage(chatId, 'Booking cancelled. Tap /start anytime.');
}
