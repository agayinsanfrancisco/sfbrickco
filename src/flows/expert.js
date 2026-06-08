import { config } from '../config.js';
import {
  getUserByTelegramId,
  getUserById,
  listOpenBookings,
  acceptOpenBooking,
  getBooking,
  listExperts,
  setUserAddress,
  listBookingsForExpert,
  expertRatingSummary,
  getExpertAvailability,
  setExpertAvailability,
} from '../supabase.js';
import { estimateBetween } from '../uber.js';
import { expertJobKeyboard } from '../lib/keyboards.js';
import { usd, fmtHourRange } from '../lib/format.js';
import { isCovered } from '../lib/slots.js';

const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOW_LOOKUP = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function ratingLine(summary) {
  return summary.count ? `⭐ ${summary.avg} (${summary.count})` : '⭐ no ratings yet';
}

async function ensureExpert(ctx, chatId, telegramId) {
  const user = await getUserByTelegramId(telegramId);
  if (!user || (user.role !== 'expert' && user.role !== 'admin')) {
    await ctx.bot.sendMessage(chatId, 'This area is for SF Brick Co Administrators only.');
    return null;
  }
  if (!user.active) {
    await ctx.bot.sendMessage(chatId, 'Your Administrator account is currently inactive.');
    return null;
  }
  return user;
}

// Card for an open job. Travel is fixed at request time (flat fee or the
// customer books the ride), so it's the same for every Administrator.
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

// The builder portal (/builder): shows their appointments + entry points.
export async function builderPortal(ctx, chatId, telegramId) {
  const user = await getUserByTelegramId(telegramId);
  if (!user || (user.role !== 'expert' && user.role !== 'admin')) {
    await ctx.bot.sendMessage(
      chatId,
      '👷 You’re not registered as an Administrator yet. Ask the team to add your @handle, then tap /builder again.'
    );
    return;
  }
  if (!user.active) {
    await ctx.bot.sendMessage(chatId, 'Your Administrator account is currently inactive.');
    return;
  }

  const appts = await listBookingsForExpert(user.id);
  const rating = await expertRatingSummary(user.id);
  let body =
    `👷 *Administrator portal*\n📍 Base address: ${user.address || '— not set —'}\n` +
    `${ratingLine(rating)}\n\n`;
  if (!appts.length) {
    body += 'You have no upcoming appointments. Tap *Open jobs* to accept one.';
  } else {
    body += '*Your appointments:*';
    for (const b of appts) {
      const cust = await getUserByTelegramId(b.customer_telegram_id);
      const who = cust?.username ? `@${cust.username}` : `id ${b.customer_telegram_id}`;
      const pay = b.payment_status === 'paid' ? '✅ paid' : '⏳ awaiting payment';
      body +=
        `\n\n🕑 ${fmtHourRange(b.slot_start, b.slot_end)}\n` +
        `📍 ${b.customer_address}\n👤 ${who}\n` +
        `💵 ${usd(b.total_cents)} — service ${usd(b.service_fee_cents)} + travel ${usd(b.surcharge_cents)} (${pay})`;
    }
  }
  await ctx.bot.sendMessage(chatId, body, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📋 Open jobs', callback_data: 'exp:list' }],
        [{ text: '📍 Update my address', callback_data: 'exp:addr' }],
        [{ text: '🗓️ My availability', callback_data: 'exp:avail' }],
      ],
    },
  });

  // First-visit nudge: a builder can't accept jobs without a base address, so
  // prompt for it immediately if it isn't set yet.
  if (!user.address) await promptSetAddress(ctx, chatId, telegramId);
}

// ── Availability windows (#22) ───────────────────────────────────────
function fmtWindows(windows) {
  if (!windows.length) return '— none set (you’ll be offered all jobs) —';
  return windows.map((w) => `${DOW_NAMES[w.dow]} ${w.start_hour}:00–${w.end_hour}:00`).join('\n');
}

export async function showAvailability(ctx, chatId, telegramId) {
  const user = await ensureExpert(ctx, chatId, telegramId);
  if (!user) return;
  const windows = await getExpertAvailability(user.id);
  ctx.sessions.set(chatId, { flow: 'expert', step: 'awaiting_availability' });
  await ctx.bot.sendMessage(
    chatId,
    `🗓️ *Your weekly availability* (Pacific):\n${fmtWindows(windows)}\n\n` +
      'Send new windows, one per line as `Day Start End` (24h), e.g.\n' +
      '`Mon 9 17`\n`Sat 10 14`\n\nSend `clear` to remove all, or /start to keep as-is.',
    { parse_mode: 'Markdown' }
  );
}

export async function doSetAvailability(ctx, chatId, telegramId, text) {
  ctx.sessions.delete(chatId);
  const user = await getUserByTelegramId(telegramId);
  if (!user) return;
  if (String(text).trim().toLowerCase() === 'clear') {
    await setExpertAvailability(user.id, []);
    await ctx.bot.sendMessage(chatId, '✅ Availability cleared — you’ll be offered all jobs.');
    return;
  }
  const windows = [];
  for (const raw of String(text).split('\n')) {
    const m = raw.trim().match(/^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2})$/);
    if (!m) continue;
    const dow = DOW_LOOKUP[m[1].toLowerCase()];
    const start = Number.parseInt(m[2], 10);
    const end = Number.parseInt(m[3], 10);
    if (dow === undefined || start < 0 || start > 23 || end < 1 || end > 24 || end <= start) continue;
    windows.push({ dow, start_hour: start, end_hour: end });
  }
  if (!windows.length) {
    await ctx.bot.sendMessage(chatId, 'Couldn’t parse any windows. Example: `Mon 9 17`', { parse_mode: 'Markdown' });
    return;
  }
  await setExpertAvailability(user.id, windows);
  await ctx.bot.sendMessage(chatId, `✅ Availability saved:\n${fmtWindows(windows)}`, { parse_mode: 'Markdown' });
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
    await ctx.bot.sendMessage(chatId, 'Too late — another Administrator grabbed that one.');
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
      `🎉 An Administrator (${ratingLine(rating)}) accepted your booking for ${fmtHourRange(accepted.slot_start, accepted.slot_end)}!\n` +
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
  await ctx.bot.sendMessage(chatId, 'Skipped — it stays open for other Administrators.');
}

// Notify active builders of a new open job (each sees travel from their
// address). Builders with an availability schedule are only pinged for jobs
// inside their windows (#22); builders with no schedule get all jobs.
export async function notifyExpertsOfOpenBooking(ctx, booking) {
  const experts = await listExperts({ activeOnly: true });
  for (const e of experts) {
    const windows = await getExpertAvailability(e.id);
    if (windows.length && !isCovered(windows, booking.slot_start)) continue;
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
