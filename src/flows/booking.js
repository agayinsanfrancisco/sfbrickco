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
  const fee = await serviceFeeCents();
  await ctx.bot.sendMessage(
    chatId,
    `🛠️ *Book an Administrator*\n\n` +
      `One-time *${usd(fee)}* fee for a 1-hour on-site session, plus a one-way travel ` +
      `surcharge (Uber, ~${usd(config.uber.flatFallbackCents)}). Or book the Administrator's ` +
      `ride yourself and pay just *${usd(fee)}*.\n\nPick a day:`,
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
      : 'No Administrators are available that day — try another.',
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
  ctx.sessions.set(chatId, { flow: 'book', step: 'awaiting_street', data: { startIso, endIso } });
  await ctx.bot.sendMessage(chatId, 'Great. What’s your *street address*?', {
    parse_mode: 'Markdown',
    reply_markup: { force_reply: true, input_field_placeholder: '123 Main St' },
  });
}

// Address is collected in pieces (street → city → ZIP) and combined.
export async function receiveStreet(ctx, chatId, street) {
  const s = ctx.sessions.get(chatId);
  if (s?.flow !== 'book' || s.step !== 'awaiting_street') return;
  ctx.sessions.set(chatId, { ...s, step: 'awaiting_city', data: { ...s.data, street } });
  await ctx.bot.sendMessage(chatId, 'And the *city*?', {
    parse_mode: 'Markdown',
    reply_markup: { force_reply: true, input_field_placeholder: 'San Francisco' },
  });
}

export async function receiveCity(ctx, chatId, city) {
  const s = ctx.sessions.get(chatId);
  if (s?.flow !== 'book' || s.step !== 'awaiting_city') return;
  ctx.sessions.set(chatId, { ...s, step: 'awaiting_zip', data: { ...s.data, city } });
  await ctx.bot.sendMessage(chatId, 'And your *ZIP code*?', {
    parse_mode: 'Markdown',
    reply_markup: { force_reply: true, input_field_placeholder: '94110' },
  });
}

// Final address piece → combine + show the confirm (with the travel choice).
export async function receiveZip(ctx, chatId, telegramId, zip) {
  const s = ctx.sessions.get(chatId);
  if (s?.flow !== 'book' || s.step !== 'awaiting_zip' || !s.data?.startIso) return;
  const { startIso, endIso, street, city } = s.data;
  const address = `${street}, ${city}, CA ${zip}`.replace(/\s+/g, ' ').trim();
  ctx.sessions.set(chatId, { ...s, step: 'awaiting_confirm', data: { startIso, endIso, address } });
  const fee = await serviceFeeCents();
  await ctx.bot.sendMessage(
    chatId,
    `Please confirm your request:\n\n🕒 ${fmtHourRange(startIso, endIso)}\n📍 ${address}\n\n` +
      `How should the Administrator’s travel work?`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: `✅ Add Uber travel (~${usd(config.uber.flatFallbackCents)})`, callback_data: 'book:reqok:travel' }],
          [{ text: `✅ I’ll book their ride — ${usd(fee)} only`, callback_data: 'book:reqok:ride' }],
          [{ text: '✖ Cancel', callback_data: 'book:cancel' }],
        ],
      },
    }
  );
}

export async function confirmRequest(ctx, chatId, telegramId, ownRide = false) {
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
    // Own-ride bookings are pre-priced (no travel); others price on acceptance.
    surcharge_source: ownRide ? 'customer_ride' : 'pending',
    total_cents: serviceFee, // placeholder until a builder accepts (or final, for own-ride)
    status: 'awaiting_acceptance',
    customer_books_ride: ownRide,
  });

  const tail = ownRide
    ? `You’re booking the Administrator’s ride, so your total is just *${usd(serviceFee)}*. An Administrator will accept, then we’ll send your payment link.`
    : `An Administrator will accept your job, then we’ll send your payment link (service ${usd(serviceFee)} + one-way travel).`;
  await ctx.bot.sendMessage(
    chatId,
    `📝 *Request submitted* for ${fmtHourRange(startIso, endIso)}\n📍 ${address}\n\n${tail}`,
    { parse_mode: 'Markdown' }
  );
  await notifyExpertsOfOpenBooking(ctx, booking);

  // Upsell bricks at 20% off, before they pay (#11).
  await ctx.bot.sendMessage(
    chatId,
    `🧱 *While you’re here* — add bricks to your build and take *20% off* your parts order.`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '🧱 Add bricks (20% off)', callback_data: 'shop:upsell' }]] },
    }
  );
}

// Customer chose to pay → present available payment methods (card / crypto).
export async function payBooking(ctx, chatId, _telegramId, bookingId) {
  await presentBookingMethods(ctx, chatId, bookingId);
}

export function cancelBooking(ctx, chatId) {
  ctx.sessions.delete(chatId);
  return ctx.bot.sendMessage(chatId, 'Booking cancelled. Tap /start anytime.');
}
