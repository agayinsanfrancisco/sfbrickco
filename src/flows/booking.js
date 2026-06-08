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
  const fee = await serviceFeeCents();
  const flat = config.uber.flatFallbackCents;
  ctx.sessions.set(chatId, { flow: 'book', step: 'choosing_travel' });
  await ctx.bot.sendMessage(
    chatId,
    `🛠️ *Book an Administrator*\n\n` +
      `One-time *${usd(fee)}* fee for a 1-hour on-site session. The Administrator needs a ride ` +
      `to you — how do you want to handle it?`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: `🚗 I’ll book their ride — ${usd(fee)} total`, callback_data: 'book:travel:ride' }],
          [{ text: `➕ Flat ${usd(flat)} travel fee — ${usd(fee + flat)} total`, callback_data: 'book:travel:flat' }],
        ],
      },
    }
  );
}

// Travel decided up front → carry it through scheduling, then show days.
export async function chooseTravel(ctx, chatId, ownRide) {
  const s = ctx.sessions.get(chatId) || {};
  ctx.sessions.set(chatId, { ...s, flow: 'book', ownRide, step: 'choosing_day' });
  const days = upcomingDays(7);
  await ctx.bot.sendMessage(chatId, 'Pick a day (sessions are bookable up to 12 hours ahead):', {
    ...daysKeyboard(days),
  });
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
  const s = ctx.sessions.get(chatId) || {};
  ctx.sessions.set(chatId, { ...s, flow: 'book', step: 'awaiting_street', data: { startIso, endIso } });
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

// Final address piece → combine + show the confirm summary.
export async function receiveZip(ctx, chatId, telegramId, zip) {
  const s = ctx.sessions.get(chatId);
  if (s?.flow !== 'book' || s.step !== 'awaiting_zip' || !s.data?.startIso) return;
  const { startIso, endIso, street, city } = s.data;
  const address = `${street}, ${city}, CA ${zip}`.replace(/\s+/g, ' ').trim();
  ctx.sessions.set(chatId, { ...s, step: 'awaiting_confirm', data: { startIso, endIso, address } });
  const fee = await serviceFeeCents();
  const surcharge = s.ownRide ? 0 : config.uber.flatFallbackCents;
  const total = fee + surcharge;
  const costLine = s.ownRide
    ? `💵 *${usd(total)}* (you book the ride)`
    : `💵 *${usd(total)}* (service ${usd(fee)} + ${usd(surcharge)} travel)`;
  await ctx.bot.sendMessage(
    chatId,
    `Please confirm your request:\n\n🕒 ${fmtHourRange(startIso, endIso)}\n📍 ${address}\n${costLine}`,
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
  const ownRide = !!session.ownRide;
  ctx.sessions.delete(chatId);

  // Re-check the slot at confirm time (it may have been taken meanwhile).
  if (await slotTaken(startIso)) {
    await ctx.bot.sendMessage(chatId, 'Sorry, that hour was just taken. Tap /book to pick another.');
    return;
  }

  const serviceFee = await serviceFeeCents();
  const surcharge = ownRide ? 0 : config.uber.flatFallbackCents;
  const total = serviceFee + surcharge;
  const booking = await createBooking({
    customer_telegram_id: telegramId,
    customer_address: address,
    slot_start: startIso,
    slot_end: endIso,
    service_fee_cents: serviceFee,
    surcharge_cents: surcharge, // flat travel fee, or 0 if customer books the ride
    surcharge_source: ownRide ? 'customer_ride' : 'manual',
    total_cents: total, // final at request time (no per-distance pricing on accept)
    status: 'awaiting_acceptance',
    customer_books_ride: ownRide,
  });

  const tail = ownRide
    ? `You’re booking the Administrator’s ride, so your total is *${usd(total)}*. An Administrator will accept, then we’ll send your payment link.`
    : `Total *${usd(total)}* (service ${usd(serviceFee)} + ${usd(surcharge)} travel). An Administrator will accept, then we’ll send your payment link.`;
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
