import { config } from '../config.js';
import { createBooking, slotTaken, listActiveAvailability } from '../supabase.js';
import { upcomingDays, hourlySlots, isCovered } from '../lib/slots.js';
import { daysKeyboard, hoursKeyboard } from '../lib/keyboards.js';
import { usd, fmtHourRange } from '../lib/format.js';
import { getIntSetting, getBoolSetting } from '../lib/settings.js';
import { presentBookingMethods } from './payments.js';
import { notifyExpertsOfOpenBooking } from './expert.js';

// Service fee: admin-editable setting, falling back to the env-derived default.
export function serviceFeeCents() {
  return getIntSetting('service_fee_cents', config.pricing.serviceFeeCents);
}

export async function startBooking(ctx, chatId) {
  if (!(await getBoolSetting('flag_booking', true))) {
    await ctx.bot.sendMessage(chatId, '🛠️ Bookings are paused right now — check back soon!');
    return;
  }
  const days = upcomingDays(7);
  await ctx.bot.sendMessage(
    chatId,
    `🛠️ *Book on-site build help*\n\n` +
      `Base fee ${usd(await serviceFeeCents())} for a 1-hour on-site session, ` +
      `plus a travel surcharge (Uber from the builder to you).\n\nPick a day:`,
    { parse_mode: 'Markdown', ...daysKeyboard(days) }
  );
}

export async function pickDay(ctx, chatId, dateKey) {
  const slots = hourlySlots(dateKey);
  // Only offer hours a builder is available for (#22). With no schedules set
  // anywhere, isCovered returns true so all slots show.
  const avail = await listActiveAvailability();
  const open = slots.filter((s) => isCovered(avail, s.startIso));
  await ctx.bot.sendMessage(
    chatId,
    open.length
      ? 'Pick a 1-hour start time (Pacific):'
      : 'No builders are available that day — try another.',
    hoursKeyboard(open)
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
    'Great. What is the *full address* where you need build help?\n' +
      '(Street, city, ZIP — used to estimate the travel surcharge.)',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        force_reply: true,
        input_field_placeholder: '123 Main St, San Francisco, CA 94110',
      },
    }
  );
}

// Called from the text handler once we have the address in session.
// New flow: create an OPEN job (no charge yet) and notify builders. The travel
// cost is priced when a builder accepts (from that builder's address), then the
// customer is sent a payment link.
// Collect the address, then show a confirm summary before submitting (#9).
export async function receiveAddress(ctx, chatId, telegramId, address) {
  const session = ctx.sessions.get(chatId);
  if (!session?.data?.startIso) {
    await ctx.bot.sendMessage(chatId, 'Let’s start over — tap "Book build help".');
    ctx.sessions.delete(chatId);
    return;
  }
  const { startIso, endIso } = session.data;
  ctx.sessions.set(chatId, { ...session, step: 'awaiting_confirm', data: { startIso, endIso, address } });
  await ctx.bot.sendMessage(
    chatId,
    `Please confirm your request:\n\n🕒 ${fmtHourRange(startIso, endIso)}\n📍 ${address}\n` +
      `💵 Base ${usd(await serviceFeeCents())} + travel (priced when a builder accepts)`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Confirm request', callback_data: 'book:reqok' }],
          [{ text: '✖ Cancel', callback_data: 'book:cancel' }],
        ],
      },
    }
  );
}

export async function confirmRequest(ctx, chatId, telegramId) {
  const session = ctx.sessions.get(chatId);
  if (session?.step !== 'awaiting_confirm' || !session?.data?.startIso) {
    await ctx.bot.sendMessage(chatId, 'That request expired — tap /book to start again.');
    return;
  }
  const { startIso, endIso, address } = session.data;
  ctx.sessions.delete(chatId);

  // Re-check the slot at confirm time (it may have been taken meanwhile).
  if (await slotTaken(startIso)) {
    await ctx.bot.sendMessage(chatId, 'Sorry, that hour was just taken. Tap /book to pick another.');
    return;
  }

  const serviceFee = await serviceFeeCents();
  const booking = await createBooking({
    customer_telegram_id: telegramId,
    customer_address: address,
    slot_start: startIso,
    slot_end: endIso,
    service_fee_cents: serviceFee,
    surcharge_cents: 0,
    surcharge_source: 'pending',
    total_cents: serviceFee, // placeholder until a builder accepts
    status: 'awaiting_acceptance',
  });

  await ctx.bot.sendMessage(
    chatId,
    `📝 *Request submitted* for ${fmtHourRange(startIso, endIso)}\n📍 ${address}\n\n` +
      `A builder will accept your job, then we’ll send your payment link ` +
      `(service ${usd(serviceFee)} + travel from the builder to you).`,
    { parse_mode: 'Markdown' }
  );
  await notifyExpertsOfOpenBooking(ctx, booking);
}

// Customer chose to pay → present available payment methods (card / crypto).
export async function payBooking(ctx, chatId, _telegramId, bookingId) {
  await presentBookingMethods(ctx, chatId, bookingId);
}

export function cancelBooking(ctx, chatId) {
  ctx.sessions.delete(chatId);
  return ctx.bot.sendMessage(chatId, 'Booking cancelled. Tap /start anytime.');
}
