import { config } from '../config.js';
import {
  getUserByTelegramId,
  getUserById,
  listOpenBookings,
  acceptOpenBooking,
  getBooking,
  listExperts,
  setUserAddress,
  setUserRate,
  listBookingsForExpert,
  expertRatingSummary,
  getExpertAvailability,
  setExpertAvailability,
  listBookedExpertIdsAt,
  reassignBooking,
  markBookingCancelled,
  getExpertTimeOff,
  isExpertTimeOff,
  addExpertTimeOff,
  removeExpertTimeOff,
  markBookingCompleted,
  builderEarnings,
  setBuilderAgreement,
} from '../supabase.js';
import { promptReview } from './review.js';
import { expertJobKeyboard } from '../lib/keyboards.js';
import { usd, fmtHourRange, shortRef } from '../lib/format.js';
import { isCovered, BLOCKS, blockActive, upcomingDays, hourlySlots } from '../lib/slots.js';

const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function ratingLine(summary) {
  return summary.count ? `⭐ ${summary.avg} (${summary.count})` : '⭐ no ratings yet';
}

// The contractor / non-circumvention agreement every builder must accept once
// before they can work. Stored as users.builder_agreement_at.
export const BUILDER_AGREEMENT =
  '🤝 *Block Expert Agreement*\n\n' +
  'Before you can take jobs, please confirm you agree to the following:\n\n' +
  '• You are an *independent contractor* — not an employee, agent, or partner of SF Brick Company — and you’re responsible for your own taxes, conduct, and safety.\n' +
  '• *Non-circumvention:* all bookings, rebookings, and payments with customers you meet through SF Brick Company go *through the platform*. Taking a customer off-platform (or sharing contact info to do so) is grounds for immediate removal and forfeiture of pending payouts.\n' +
  '• We collect the customer’s payment and pay you out your share (your rate minus the platform fee).\n' +
  '• You’ll show up on time, keep customer information private, and cancel through the bot if you can’t make it (we’ll reassign the job).\n\n' +
  'Do you agree?';

async function presentBuilderAgreement(ctx, chatId) {
  await ctx.bot.sendMessage(chatId, BUILDER_AGREEMENT, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ I agree', callback_data: 'exp:agreeyes' }],
        [{ text: '✖ Not now', callback_data: 'exp:agreeno' }],
      ],
    },
  });
}

export async function acceptBuilderAgreement(ctx, chatId, telegramId) {
  const user = await getUserByTelegramId(telegramId);
  if (!user || (user.role !== 'expert' && user.role !== 'admin')) return;
  await setBuilderAgreement(telegramId);
  await ctx.bot.sendMessage(chatId, '🤝 Agreement recorded — welcome aboard! Opening your portal…');
  await builderPortal(ctx, chatId, telegramId);
}

export async function declineBuilderAgreement(ctx, chatId) {
  await ctx.bot.sendMessage(
    chatId,
    'No problem — you can accept anytime with /builder. You won’t receive jobs until then.'
  );
}

async function ensureExpert(ctx, chatId, telegramId) {
  const user = await getUserByTelegramId(telegramId);
  if (!user || (user.role !== 'expert' && user.role !== 'admin')) {
    await ctx.bot.sendMessage(chatId, 'This area is for SF Brick Co Block Experts only.');
    return null;
  }
  if (!user.active) {
    await ctx.bot.sendMessage(chatId, 'Your Block Expert account is currently inactive.');
    return null;
  }
  if (!user.builder_agreement_at) {
    await presentBuilderAgreement(ctx, chatId);
    return null;
  }
  return user;
}

// Card for an open job. Travel is fixed at request time (flat fee or the
// customer books the ride), so it's the same for every Block Expert.
function openJobCard(booking) {
  const travel = booking.customer_books_ride
    ? '🚗 Customer books your ride'
    : `🚕 ${usd(booking.surcharge_cents)} travel included`;
  return (
    `🛠️ *Open job*\n` +
    `🕑 ${fmtHourRange(booking.slot_start, booking.slot_end)}\n` +
    `📍 ${booking.customer_address}\n` +
    `💵 *${usd(booking.total_cents)}* (service ${usd(booking.service_fee_cents)})\n${travel}`
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

// Per-Block Expert rate (what the customer pays); we take a platform fee.
export async function promptSetRate(ctx, chatId, telegramId) {
  const user = await ensureExpert(ctx, chatId, telegramId);
  if (!user) return;
  ctx.sessions.set(chatId, { flow: 'expert', step: 'awaiting_rate' });
  const fee = config.pricing.platformFeePct;
  const current = user.rate_cents != null ? `\nCurrent: ${usd(user.rate_cents)}` : '';
  const exampleNet = Math.round((4000 * (100 - fee)) / 100);
  await ctx.bot.sendMessage(
    chatId,
    `💲 *Set your rate* per 1-hour session — this is what the customer pays.${current}\n\n` +
      `⚠️ We take a *${fee}% platform fee*, so you keep *${100 - fee}%*. ` +
      `For example, at $40 you’d earn ${usd(exampleNet)}.\n\nSend your price in dollars:`,
    { parse_mode: 'Markdown', reply_markup: { force_reply: true, input_field_placeholder: '40' } }
  );
}

export async function doSetRate(ctx, chatId, telegramId, text) {
  ctx.sessions.delete(chatId);
  const dollars = Number.parseFloat(String(text).replace(/[^0-9.]/g, ''));
  if (Number.isNaN(dollars) || dollars <= 0) {
    await ctx.bot.sendMessage(chatId, 'Please send a valid dollar amount (e.g. 40).');
    return;
  }
  const cents = Math.round(dollars * 100);
  const updated = await setUserRate(telegramId, cents);
  const fee = config.pricing.platformFeePct;
  const net = Math.round((cents * (100 - fee)) / 100);
  await ctx.bot.sendMessage(
    chatId,
    updated
      ? `✅ Rate set to ${usd(cents)} — you’ll earn ${usd(net)} after our ${fee}% fee.`
      : 'Could not save your rate.'
  );
}

// The builder portal (/builder): shows their appointments + entry points.
export async function builderPortal(ctx, chatId, telegramId) {
  const user = await getUserByTelegramId(telegramId);
  if (!user || (user.role !== 'expert' && user.role !== 'admin')) {
    await ctx.bot.sendMessage(
      chatId,
      '👷 You’re not registered as a Block Expert yet. Ask the team to add your @handle, then tap /builder again.'
    );
    return;
  }
  if (!user.active) {
    await ctx.bot.sendMessage(chatId, 'Your Block Expert account is currently inactive.');
    return;
  }
  if (!user.builder_agreement_at) {
    await presentBuilderAgreement(ctx, chatId);
    return;
  }

  const appts = await listBookingsForExpert(user.id);
  const rating = await expertRatingSummary(user.id);
  const earnings = await builderEarnings(user.id);
  const fee = config.pricing.platformFeePct;
  const netEarned = Math.round((earnings.grossCents * (100 - fee)) / 100);
  const owed = Math.max(0, netEarned - earnings.paidOutCents);
  const rateStr = user.rate_cents != null ? usd(user.rate_cents) : `${usd(config.pricing.serviceFeeCents)} (default)`;
  let body =
    `👷 *Block Expert portal*\n📍 Base address: ${user.address || '— not set —'}\n` +
    `💲 Your rate: ${rateStr}\n${ratingLine(rating)}\n` +
    `💵 Earned ${usd(netEarned)} across ${earnings.jobs} paid job${earnings.jobs === 1 ? '' : 's'} · paid out ${usd(
      earnings.paidOutCents
    )} · *owed ${usd(owed)}*\n\n`;
  if (!appts.length) {
    body += 'You have no upcoming appointments yet. Set your availability so customers can book you.';
  } else {
    body += '*Your appointments:*';
    for (const b of appts) {
      const paid = b.payment_status === 'paid';
      // Reveal the customer's name + handle only after payment.
      let who = 'shown after payment';
      if (paid) {
        const cust = await getUserByTelegramId(b.customer_telegram_id);
        who = cust
          ? `${cust.full_name || 'Customer'}${cust.username ? ` (@${cust.username})` : ''}`
          : `id ${b.customer_telegram_id}`;
      }
      const net = Math.round((b.service_fee_cents * (100 - config.pricing.platformFeePct)) / 100);
      body +=
        `\n\n🕑 ${fmtHourRange(b.slot_start, b.slot_end)}\n` +
        `📍 ${b.customer_address}\n👤 ${who}\n` +
        `💵 You earn *${usd(net)}* (customer pays ${usd(b.total_cents)}) — ${paid ? '✅ paid' : '⏳ awaiting payment'}`;
    }
  }
  await ctx.bot.sendMessage(chatId, body, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '📋 My jobs', callback_data: 'exp:jobs' },
          { text: '🗓️ Availability', callback_data: 'exp:avail' },
        ],
        [
          { text: '💲 Set my rate', callback_data: 'exp:rate' },
          { text: '📍 Address', callback_data: 'exp:addr' },
        ],
      ],
    },
  });

  // First-visit nudge: a builder can't accept jobs without a base address, so
  // prompt for it immediately if it isn't set yet.
  if (!user.address) await promptSetAddress(ctx, chatId, telegramId);
}

// ── Availability windows (#22) — tap-based weekly grid ───────────────
// Builders toggle day-part blocks (Morning/Afternoon/Evening) per weekday.
// Each active block is stored as one [start_hour, end_hour) window. No typing.

function availabilityKeyboard(windows) {
  const rows = [];
  // One-tap presets for the common cases (set the whole week at once).
  rows.push([
    { text: '⚡ Weekdays 9–5', callback_data: 'exp:avpreset:weekdays' },
    { text: '⚡ Every day 9–9', callback_data: 'exp:avpreset:everyday' },
  ]);
  rows.push([
    { text: '⚡ Weekends 9–9', callback_data: 'exp:avpreset:weekends' },
    { text: '🧹 Clear all', callback_data: 'exp:avpreset:clear' },
  ]);
  // Mon–Sun order (more natural than Sun-first for a work week).
  for (const dow of [1, 2, 3, 4, 5, 6, 0]) {
    const row = [{ text: DOW_NAMES[dow], callback_data: 'noop' }];
    for (const block of BLOCKS) {
      const on = blockActive(windows, dow, block);
      row.push({
        text: `${on ? '✅' : '➕'} ${block.label.split(' ')[1]}`,
        callback_data: `exp:av:${dow}:${block.key}`,
      });
    }
    rows.push(row);
  }
  rows.push([{ text: '🚫 Block a specific time off', callback_data: 'exp:off' }]);
  rows.push([{ text: '✅ Done', callback_data: 'exp:avdone' }]);
  return { reply_markup: { inline_keyboard: rows } };
}

// Build the windows for a one-tap preset. Blocks: Morning 9–13, Afternoon
// 13–17, Evening 17–21. "Weekdays 9–5" = Mon–Fri Morning+Afternoon; the
// "every day"/"weekends" presets include all three blocks (→ 9–9).
export function presetWindows(preset) {
  const day = BLOCKS.filter((b) => b.key !== 'pm'); // Morning + Afternoon → 9–17
  const all = BLOCKS; // 9–21
  const make = (dows, blocks) =>
    dows.flatMap((dow) => blocks.map((b) => ({ dow, start_hour: b.start, end_hour: b.end })));
  switch (preset) {
    case 'weekdays':
      return make([1, 2, 3, 4, 5], day);
    case 'everyday':
      return make([0, 1, 2, 3, 4, 5, 6], all);
    case 'weekends':
      return make([0, 6], all);
    case 'clear':
      return [];
    default:
      return null;
  }
}

export async function applyAvailPreset(ctx, chatId, telegramId, preset, messageId) {
  const user = await ensureExpert(ctx, chatId, telegramId);
  if (!user) return;
  const windows = presetWindows(preset);
  if (windows === null) return;
  await setExpertAvailability(user.id, windows);
  try {
    await ctx.bot.editMessageReplyMarkup(availabilityKeyboard(windows).reply_markup, {
      chat_id: chatId,
      message_id: messageId,
    });
  } catch {
    await showAvailability(ctx, chatId, telegramId);
  }
}

const AVAIL_HEADER =
  '🗓️ *Your weekly hours* (Pacific)\n' +
  'Use a ⚡ preset to set everything at once, then tap any block to fine-tune. ' +
  'Customers can only book you during your ✅ hours.\n' +
  '_Leave everything off to be offered every job._\n\n' +
  'Morning 9–1 · Afternoon 1–5 · Evening 5–9';

export async function showAvailability(ctx, chatId, telegramId) {
  const user = await ensureExpert(ctx, chatId, telegramId);
  if (!user) return;
  const windows = await getExpertAvailability(user.id);
  await ctx.bot.sendMessage(chatId, AVAIL_HEADER, {
    parse_mode: 'Markdown',
    ...availabilityKeyboard(windows),
  });
}

export async function toggleAvailBlock(ctx, chatId, telegramId, dow, blockKey, messageId) {
  const user = await ensureExpert(ctx, chatId, telegramId);
  if (!user) return;
  const block = BLOCKS.find((b) => b.key === blockKey);
  if (!block || Number.isNaN(dow)) return;
  let windows = await getExpertAvailability(user.id);
  if (blockActive(windows, dow, block)) {
    windows = windows.filter((w) => !(w.dow === dow && w.start_hour === block.start && w.end_hour === block.end));
  } else {
    windows.push({ dow, start_hour: block.start, end_hour: block.end });
  }
  windows = windows.map((w) => ({ dow: w.dow, start_hour: w.start_hour, end_hour: w.end_hour }));
  await setExpertAvailability(user.id, windows);
  try {
    await ctx.bot.editMessageReplyMarkup(availabilityKeyboard(windows).reply_markup, {
      chat_id: chatId,
      message_id: messageId,
    });
  } catch {
    /* nothing changed visibly */
  }
}

export async function clearAvailability(ctx, chatId, telegramId, messageId) {
  const user = await ensureExpert(ctx, chatId, telegramId);
  if (!user) return;
  await setExpertAvailability(user.id, []);
  try {
    await ctx.bot.editMessageReplyMarkup(availabilityKeyboard([]).reply_markup, {
      chat_id: chatId,
      message_id: messageId,
    });
  } catch {
    /* ignore */
  }
}

export async function doneAvailability(ctx, chatId, telegramId) {
  const user = await ensureExpert(ctx, chatId, telegramId);
  if (!user) return;
  const windows = await getExpertAvailability(user.id);
  const summary = windows.length
    ? windows
        .slice()
        .sort((a, b) => a.dow - b.dow || a.start_hour - b.start_hour)
        .map((w) => `${DOW_NAMES[w.dow]} ${w.start_hour}:00–${w.end_hour}:00`)
        .join(', ')
    : 'open to every job (no hours set)';
  await ctx.bot.sendMessage(chatId, `✅ Saved. You’re available: ${summary}.`);
}

// ── Block specific time off (one-off unavailable hours) ──────────────
function timeOffKeyboard(slots, blockedSet) {
  const rows = slots.map((s) => [
    {
      text: `${blockedSet.has(s.startIso) ? '🚫 Blocked' : '🟢 Free'} · ${s.dayLabel} ${s.label}`,
      callback_data: `exp:off:${s.startIso}`,
    },
  ]);
  rows.push([{ text: '⬅️ Back to weekly hours', callback_data: 'exp:avail' }]);
  return { reply_markup: { inline_keyboard: rows } };
}

// Upcoming bookable hours in the next-12h window (what a customer could book).
function upcomingSlots() {
  const out = [];
  for (const day of upcomingDays(2)) {
    for (const s of hourlySlots(day.dateKey)) out.push({ ...s, dayLabel: day.label });
  }
  return out;
}

export async function showTimeOff(ctx, chatId, telegramId) {
  const user = await ensureExpert(ctx, chatId, telegramId);
  if (!user) return;
  const slots = upcomingSlots();
  if (!slots.length) {
    await ctx.bot.sendMessage(chatId, 'No bookable hours in the next 12 hours to block right now.');
    return;
  }
  const blocked = new Set(await getExpertTimeOff(user.id));
  await ctx.bot.sendMessage(
    chatId,
    '🚫 *Block time off*\nTap an hour to mark yourself unavailable (these are the next-12h hours a customer could book). Tap again to free it up.',
    { parse_mode: 'Markdown', ...timeOffKeyboard(slots, blocked) }
  );
}

export async function toggleTimeOff(ctx, chatId, telegramId, slotIso, messageId) {
  const user = await ensureExpert(ctx, chatId, telegramId);
  if (!user) return;
  if (await isExpertTimeOff(user.id, slotIso)) {
    await removeExpertTimeOff(user.id, slotIso);
  } else {
    await addExpertTimeOff(user.id, slotIso);
  }
  const blocked = new Set(await getExpertTimeOff(user.id));
  try {
    await ctx.bot.editMessageReplyMarkup(timeOffKeyboard(upcomingSlots(), blocked).reply_markup, {
      chat_id: chatId,
      message_id: messageId,
    });
  } catch {
    /* ignore */
  }
}

// ── Manage my jobs (cancel → reassign to next free, else support) ────
async function findReplacementAdmin(slotIso, excludeId) {
  const experts = await listExperts({ activeOnly: true });
  const bookedIds = await listBookedExpertIdsAt(slotIso);
  for (const e of experts) {
    if (e.id === excludeId || bookedIds.includes(e.id)) continue;
    const windows = await getExpertAvailability(e.id);
    if (windows.length && !isCovered(windows, slotIso)) continue;
    if (await isExpertTimeOff(e.id, slotIso)) continue;
    return e;
  }
  return null;
}

export async function showMyJobs(ctx, chatId, telegramId) {
  const user = await ensureExpert(ctx, chatId, telegramId);
  if (!user) return;
  const jobs = await listBookingsForExpert(user.id);
  if (!jobs.length) {
    await ctx.bot.sendMessage(chatId, 'You have no upcoming jobs.');
    return;
  }
  for (const b of jobs) {
    const paid = b.payment_status === 'paid';
    const sessionStarted = Date.parse(b.slot_start) <= Date.now();
    const buttons = [];
    // After a paid session's start, the builder confirms it happened — this
    // completes the booking, prompts the customer review, and locks earnings.
    if (paid && sessionStarted) buttons.push({ text: '✅ Job done', callback_data: `exp:done:${b.id}` });
    buttons.push({ text: '✖ Cancel this job', callback_data: `exp:cancel:${b.id}` });
    await ctx.bot.sendMessage(
      chatId,
      `🛠️ ${shortRef(b.id)} — ${fmtHourRange(b.slot_start, b.slot_end)}\n📍 ${b.customer_address}\n` +
        `💵 ${usd(b.total_cents)} · ${paid ? '✅ paid' : '⏳ awaiting payment'}`,
      { reply_markup: { inline_keyboard: [buttons] } }
    );
  }
}

export async function jobDone(ctx, chatId, telegramId, bookingId) {
  const user = await ensureExpert(ctx, chatId, telegramId);
  if (!user) return;
  const booking = await getBooking(bookingId);
  if (!booking || booking.expert_id !== user.id) {
    await ctx.bot.sendMessage(chatId, 'That job isn’t yours to complete.');
    return;
  }
  if (Date.parse(booking.slot_start) > Date.now()) {
    await ctx.bot.sendMessage(chatId, 'That session hasn’t started yet.');
    return;
  }
  const completed = await markBookingCompleted(bookingId);
  if (!completed) {
    await ctx.bot.sendMessage(chatId, 'That job can’t be completed (unpaid or already closed).');
    return;
  }
  const fee = config.pricing.platformFeePct;
  const net = Math.round((completed.service_fee_cents * (100 - fee)) / 100);
  await ctx.bot.sendMessage(
    chatId,
    `🎉 Job ${shortRef(bookingId)} marked done — *${usd(net)}* added to your earnings. The customer has been asked for a rating.`,
    { parse_mode: 'Markdown' }
  );
  if (!completed.review_prompted) await promptReview(ctx, completed);
}

export async function cancelJob(ctx, chatId, telegramId, bookingId) {
  const user = await ensureExpert(ctx, chatId, telegramId);
  if (!user) return;
  const booking = await getBooking(bookingId);
  if (!booking || booking.expert_id !== user.id || !['awaiting_payment', 'accepted'].includes(booking.status)) {
    await ctx.bot.sendMessage(chatId, 'That job can’t be cancelled.');
    return;
  }
  const when = fmtHourRange(booking.slot_start, booking.slot_end);
  const replacement = await findReplacementAdmin(booking.slot_start, user.id);
  if (replacement) {
    await reassignBooking(bookingId, replacement.id);
    const travel = booking.customer_books_ride
      ? 'Customer books your ride.'
      : `${usd(booking.surcharge_cents)} travel included.`;
    const paidNote = booking.payment_status === 'paid' ? ' (already paid)' : ' — pending payment';
    try {
      await ctx.bot.sendMessage(
        replacement.telegram_id,
        `📋 You’ve been assigned a job for ${when}.\n📍 ${booking.customer_address}\n${travel} Total ${usd(booking.total_cents)}${paidNote}.`
      );
    } catch {
      /* ignore */
    }
    const rating = await expertRatingSummary(replacement.id);
    const rname = replacement.full_name || (replacement.username ? `@${replacement.username}` : 'another Block Expert');
    try {
      await ctx.bot.sendMessage(
        booking.customer_telegram_id,
        `🔄 Your Block Expert had to cancel — *${rname}* (${ratingLine(rating)}) has taken over your ${when} booking. No action needed.`,
        { parse_mode: 'Markdown' }
      );
    } catch {
      /* ignore */
    }
    await ctx.bot.sendMessage(chatId, '✅ Cancelled — reassigned to another available Block Expert.');
  } else {
    await markBookingCancelled(bookingId);
    const refundNote = booking.payment_status === 'paid' ? ' We’ll arrange a reschedule or refund.' : '';
    try {
      await ctx.bot.sendMessage(
        booking.customer_telegram_id,
        `⚠️ Your Block Expert had to cancel your ${when} booking and no one else is available for that time.${refundNote}\nPlease chat with support:`,
        { reply_markup: { inline_keyboard: [[{ text: '💬 Chat with support', url: 'https://t.me/redbluebrick' }]] } }
      );
    } catch {
      /* ignore */
    }
    for (const adminId of config.adminIds) {
      try {
        await ctx.bot.sendMessage(
          adminId,
          `⚠️ Booking ${shortRef(bookingId)} (${when}) — Block Expert cancelled, no replacement available. ` +
            `${booking.payment_status === 'paid' ? 'PAID — needs refund/reschedule.' : 'unpaid.'} Customer routed to support.`
        );
      } catch {
        /* ignore */
      }
    }
    await ctx.bot.sendMessage(chatId, '✅ Cancelled. No replacement was available — the customer was directed to support.');
  }
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
    await ctx.bot.sendMessage(chatId, openJobCard(b), {
      parse_mode: 'Markdown',
      ...expertJobKeyboard(b.id),
    });
  }
}

export async function accept(ctx, chatId, telegramId, bookingId) {
  const user = await ensureExpert(ctx, chatId, telegramId);
  if (!user) return;
  const booking = await getBooking(bookingId);
  if (!booking || booking.status !== 'awaiting_acceptance') {
    await ctx.bot.sendMessage(chatId, 'That job is no longer open.');
    return;
  }
  // Travel + total are already fixed on the booking (flat fee or own-ride).
  const accepted = await acceptOpenBooking(bookingId, user.id);
  if (!accepted) {
    await ctx.bot.sendMessage(chatId, 'Too late — another Block Expert grabbed that one.');
    return;
  }
  const travelNote = accepted.customer_books_ride
    ? 'Customer is booking your ride.'
    : `${usd(accepted.surcharge_cents)} travel included.`;
  await ctx.bot.sendMessage(
    chatId,
    `✅ You took the job for ${fmtHourRange(accepted.slot_start, accepted.slot_end)}.\n` +
      `📍 ${accepted.customer_address}\n${travelNote} Awaiting customer payment.`
  );
  const rating = await expertRatingSummary(user.id);
  try {
    await ctx.bot.sendMessage(
      accepted.customer_telegram_id,
      `🎉 A Block Expert (${ratingLine(rating)}) accepted your booking for ${fmtHourRange(accepted.slot_start, accepted.slot_end)}!\n` +
        `• *Total: ${usd(accepted.total_cents)}*\nTap to pay:`,
      {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: `Pay ${usd(accepted.total_cents)}`, callback_data: `book:pay:${bookingId}` }]] },
      }
    );
  } catch {
    /* ignore */
  }
}

export async function decline(ctx, chatId, _bookingId) {
  await ctx.bot.sendMessage(chatId, 'Skipped — it stays open for other Block Experts.');
}

// Notify active builders of a new open job (each sees travel from their
// address). Builders with an availability schedule are only pinged for jobs
// inside their windows (#22); builders with no schedule get all jobs.
export async function notifyExpertsOfOpenBooking(ctx, booking) {
  const experts = await listExperts({ activeOnly: true });
  for (const e of experts) {
    const windows = await getExpertAvailability(e.id);
    if (windows.length && !isCovered(windows, booking.slot_start)) continue;
    if (await isExpertTimeOff(e.id, booking.slot_start)) continue;
    try {
      await ctx.bot.sendMessage(e.telegram_id, `📨 New open job:\n\n${openJobCard(booking)}`, {
        parse_mode: 'Markdown',
        ...expertJobKeyboard(booking.id),
      });
    } catch {
      /* builder hasn't opened the bot */
    }
  }
}

export { getUserById, getBooking };
