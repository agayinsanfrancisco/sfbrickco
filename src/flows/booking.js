import { config } from '../config.js';
import {
  createBooking,
  listActiveAvailability,
  listExperts,
  getExpertAvailability,
  expertRatingSummary,
  listBookedExpertIdsAt,
  isExpertBookedAt,
  isExpertTimeOff,
  getUserById,
  getBooking,
  rescheduleBooking,
} from '../supabase.js';
import { upcomingDays, hourlySlots, isCovered } from '../lib/slots.js';
import { daysKeyboard, hoursKeyboard } from '../lib/keyboards.js';
import { usd, fmtHourRange, mdEscape } from '../lib/format.js';
import { getIntSetting, getBoolSetting } from '../lib/settings.js';
import { presentWaiver } from './payments.js';

// Service fee: admin-editable setting, falling back to the env-derived default.
// Used as the price floor when a Block Expert hasn't set their own rate.
export function serviceFeeCents() {
  return getIntSetting('service_fee_cents', config.pricing.serviceFeeCents);
}

function adminName(u) {
  return u.full_name || u.username || 'Block Expert';
}

export async function startBooking(ctx, chatId) {
  if (!(await getBoolSetting('flag_booking', true))) {
    await ctx.bot.sendMessage(chatId, '🛠️ Bookings are paused right now — check back soon!');
    return;
  }
  const flat = config.uber.flatFallbackCents;
  ctx.sessions.set(chatId, { flow: 'book', step: 'choosing_travel' });
  await ctx.bot.sendMessage(
    chatId,
    `🛠️ *Book a Block Expert*\n\n` +
      `A Block Expert is a vetted local builder who comes to you for a *1-hour on-site session* to help build, hands-on.\n\n` +
      `Here’s the flow: ① how they travel → ② day → ③ time → ④ pick your Block Expert → ⑤ your address → ⑥ pay.\n\n` +
      `First — the Block Expert needs a ride to you. How do you want to handle it?`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: `🚗 I’ll book their ride (no travel fee)`, callback_data: 'book:travel:ride' }],
          [{ text: `➕ Add a flat ${usd(flat)} travel fee`, callback_data: 'book:travel:flat' }],
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
  // Only offer hours some active Block Expert is available for. With no
  // schedules set anywhere, isCovered returns true so all slots show.
  const avail = await listActiveAvailability();
  const open = slots.filter((s) => isCovered(avail, s.startIso));
  await ctx.bot.sendMessage(
    chatId,
    open.length
      ? 'Pick a 1-hour start time (Pacific):'
      : 'No Block Experts are available that day — try another.',
    hoursKeyboard(open)
  );
}

// After picking the hour, show the Block Experts available for it so the
// customer can choose one (book directly).
export async function pickHour(ctx, chatId, startIso) {
  const endIso = new Date(new Date(startIso).getTime() + 60 * 60 * 1000).toISOString();
  const s = ctx.sessions.get(chatId) || {};
  const experts = await listExperts({ activeOnly: true });
  const bookedIds = await listBookedExpertIdsAt(startIso);
  const floor = await serviceFeeCents();
  const available = [];
  for (const e of experts) {
    if (bookedIds.includes(e.id)) continue;
    const windows = await getExpertAvailability(e.id);
    if (windows.length && !isCovered(windows, startIso)) continue;
    if (await isExpertTimeOff(e.id, startIso)) continue;
    const rating = await expertRatingSummary(e.id);
    available.push({ id: e.id, name: adminName(e), rate: e.rate_cents ?? floor, rating });
  }
  if (!available.length) {
    await ctx.bot.sendMessage(chatId, 'No Block Experts are free at that hour — tap /book to pick another time.');
    return;
  }
  ctx.sessions.set(chatId, { ...s, flow: 'book', step: 'choosing_admin', data: { startIso, endIso } });
  const rows = available.map((a) => [
    {
      text: `${a.name} · ${a.rating.count ? `⭐${a.rating.avg}` : '⭐ new'} · ${usd(a.rate)}`,
      callback_data: `book:admin:${a.id}`,
    },
  ]);
  await ctx.bot.sendMessage(chatId, `Available for ${fmtHourRange(startIso, endIso)} — pick your Block Expert:`, {
    reply_markup: { inline_keyboard: rows },
  });
}

export async function chooseAdmin(ctx, chatId, expertId) {
  const s = ctx.sessions.get(chatId);
  if (s?.flow !== 'book' || s.step !== 'choosing_admin' || !s.data?.startIso) return;
  const admin = await getUserById(expertId);
  if (!admin || admin.role !== 'expert' || !admin.active) {
    await ctx.bot.sendMessage(chatId, 'That Block Expert is no longer available — tap /book to try again.');
    return;
  }
  if (await isExpertBookedAt(expertId, s.data.startIso)) {
    await ctx.bot.sendMessage(chatId, 'That Block Expert was just booked for that hour — tap /book to pick another time.');
    return;
  }
  if (await isExpertTimeOff(expertId, s.data.startIso)) {
    await ctx.bot.sendMessage(chatId, 'That Block Expert just blocked off that hour — tap /book to pick another time.');
    return;
  }
  const rate = admin.rate_cents ?? (await serviceFeeCents());
  ctx.sessions.set(chatId, { ...s, step: 'awaiting_street', expertId, adminName: adminName(admin), adminRate: rate });
  await ctx.bot.sendMessage(chatId, `Booking *${adminName(admin)}*. What’s your *street address*?`, {
    parse_mode: 'Markdown',
    reply_markup: { force_reply: true, input_field_placeholder: '123 Main St' },
  });
}

// Address collected in pieces (street → city → ZIP) and combined.
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

export async function receiveZip(ctx, chatId, telegramId, zip) {
  const s = ctx.sessions.get(chatId);
  if (s?.flow !== 'book' || s.step !== 'awaiting_zip' || !s.data?.startIso) return;
  const { startIso, endIso, street, city } = s.data;
  const address = `${street}, ${city}, CA ${zip}`.replace(/\s+/g, ' ').trim();
  ctx.sessions.set(chatId, { ...s, step: 'awaiting_confirm', data: { startIso, endIso, address } });
  const fee = s.adminRate ?? (await serviceFeeCents());
  const surcharge = s.ownRide ? 0 : config.uber.flatFallbackCents;
  const total = fee + surcharge;
  const costLine = s.ownRide
    ? `💵 *${usd(total)}* (you book the ride)`
    : `💵 *${usd(total)}* (${usd(fee)} session + ${usd(surcharge)} travel)`;
  await ctx.bot.sendMessage(
    chatId,
    `Please confirm:\n\n👤 ${mdEscape(s.adminName)}\n🕒 ${fmtHourRange(startIso, endIso)}\n📍 ${mdEscape(address)}\n${costLine}`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Confirm & continue to payment', callback_data: 'book:reqok' }],
          [{ text: '✖ Cancel', callback_data: 'book:cancel' }],
        ],
      },
    }
  );
}

export async function confirmRequest(ctx, chatId, telegramId) {
  const session = ctx.sessions.get(chatId);
  if (session?.step !== 'awaiting_confirm' || !session?.data?.startIso || !session.expertId) {
    await ctx.bot.sendMessage(chatId, 'That request expired — tap /book to start again.');
    return;
  }
  const { startIso, endIso, address } = session.data;
  const { ownRide = false, expertId, adminName: chosenName } = session;
  const serviceFee = session.adminRate ?? (await serviceFeeCents());
  ctx.sessions.delete(chatId);

  if (await isExpertBookedAt(expertId, startIso)) {
    await ctx.bot.sendMessage(chatId, 'That Block Expert was just booked for that hour — tap /book to pick another.');
    return;
  }

  const surcharge = ownRide ? 0 : config.uber.flatFallbackCents;
  const total = serviceFee + surcharge;
  const booking = await createBooking({
    customer_telegram_id: telegramId,
    customer_address: address,
    slot_start: startIso,
    slot_end: endIso,
    service_fee_cents: serviceFee,
    surcharge_cents: surcharge,
    surcharge_source: ownRide ? 'customer_ride' : 'manual',
    total_cents: total,
    status: 'awaiting_payment', // Block Expert chosen directly — no open-job step
    expert_id: expertId,
    customer_books_ride: ownRide,
  });

  // Notify the chosen Block Expert they've been booked (pending payment).
  const admin = await getUserById(expertId);
  if (admin) {
    const travel = ownRide ? 'Customer books your ride.' : `${usd(surcharge)} travel included.`;
    try {
      await ctx.bot.sendMessage(
        admin.telegram_id,
        `📋 You’ve been booked for ${fmtHourRange(startIso, endIso)}.\n📍 ${address}\n${travel} ` +
          `Total ${usd(total)} — pending the customer’s payment.`
      );
    } catch {
      /* Block Expert hasn't opened the bot */
    }
  }

  await ctx.bot.sendMessage(
    chatId,
    `📝 *Booked ${mdEscape(chosenName)}* for ${fmtHourRange(startIso, endIso)}\n📍 ${mdEscape(address)}\nTotal *${usd(total)}*.`,
    { parse_mode: 'Markdown' }
  );
  await presentWaiver(ctx, chatId, 'b', booking.id);

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

// A "Pay" button (e.g. a re-show) → waiver gate, then payment methods.
export async function payBooking(ctx, chatId, _telegramId, bookingId) {
  await presentWaiver(ctx, chatId, 'b', bookingId);
}

export function cancelBooking(ctx, chatId) {
  ctx.sessions.delete(chatId);
  return ctx.bot.sendMessage(chatId, 'Booking cancelled. Tap /start anytime.');
}

// ── Reschedule (customer moves an upcoming booking) ──────────────────
// Same Block Expert, new hour they're actually free for. Payment carries over.

async function expertFreeAt(expertId, startIso) {
  if (await isExpertBookedAt(expertId, startIso)) return false;
  if (await isExpertTimeOff(expertId, startIso)) return false;
  const windows = await getExpertAvailability(expertId);
  if (windows.length && !isCovered(windows, startIso)) return false;
  return true;
}

export async function startReschedule(ctx, chatId, telegramId, bookingId) {
  const booking = await getBooking(bookingId);
  if (
    !booking ||
    booking.customer_telegram_id !== telegramId ||
    !booking.expert_id ||
    !['awaiting_payment', 'accepted'].includes(booking.status)
  ) {
    await ctx.bot.sendMessage(chatId, 'That booking can’t be rescheduled.');
    return;
  }
  // Collect the free hours for THIS Block Expert across the bookable window.
  const options = [];
  for (const day of upcomingDays(2)) {
    for (const slot of hourlySlots(day.dateKey)) {
      if (slot.startIso === booking.slot_start) continue;
      if (await expertFreeAt(booking.expert_id, slot.startIso)) {
        options.push({ ...slot, dayLabel: day.label });
      }
    }
  }
  if (!options.length) {
    await ctx.bot.sendMessage(
      chatId,
      'No other free hours for your Block Expert in the next 12 hours — try again later, or cancel and rebook.'
    );
    return;
  }
  ctx.sessions.set(chatId, { flow: 'book', step: 'resched', bookingId });
  const rows = [];
  for (let i = 0; i < options.length; i += 2) {
    rows.push(
      options.slice(i, i + 2).map((s) => ({
        text: `${s.dayLabel} ${s.label}`,
        callback_data: `book:rs:${s.startIso}`,
      }))
    );
  }
  await ctx.bot.sendMessage(
    chatId,
    `📅 *Reschedule* — currently ${fmtHourRange(booking.slot_start, booking.slot_end)}.\nPick a new start time:`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } }
  );
}

export async function doReschedule(ctx, chatId, telegramId, startIso) {
  const s = ctx.sessions.get(chatId);
  if (s?.step !== 'resched' || !s.bookingId) return;
  ctx.sessions.delete(chatId);
  const booking = await getBooking(s.bookingId);
  if (!booking || booking.customer_telegram_id !== telegramId) return;
  // Re-validate at tap time (someone may have grabbed the hour meanwhile).
  if (!(await expertFreeAt(booking.expert_id, startIso))) {
    await ctx.bot.sendMessage(chatId, 'That hour was just taken — tap Reschedule again to pick another.');
    return;
  }
  const endIso = new Date(new Date(startIso).getTime() + 60 * 60 * 1000).toISOString();
  const updated = await rescheduleBooking(s.bookingId, startIso, endIso);
  if (!updated) {
    await ctx.bot.sendMessage(chatId, 'That booking can’t be rescheduled anymore.');
    return;
  }
  await ctx.bot.sendMessage(
    chatId,
    `✅ Rescheduled to *${fmtHourRange(updated.slot_start, updated.slot_end)}* — same Block Expert${
      updated.payment_status === 'paid' ? ', already paid' : ''
    }.`,
    { parse_mode: 'Markdown' }
  );
  // Tell the Block Expert their job moved.
  const admin = await getUserById(updated.expert_id);
  if (admin) {
    try {
      await ctx.bot.sendMessage(
        admin.telegram_id,
        `📅 Schedule change: your job at ${updated.customer_address} moved to ${fmtHourRange(
          updated.slot_start,
          updated.slot_end
        )}.`
      );
    } catch {
      /* ignore */
    }
  }
}
