import { config, isAdminId } from '../config.js';
import {
  listUsers,
  setRole,
  setActive,
  listOpenBookings,
  listExperts,
  getBooking,
  acceptOpenBooking,
  setBookingSurcharge,
  getUserByTelegramId,
  getUserById,
  listInventory,
  setStock,
} from '../supabase.js';
import { manualSurchargeCents, estimateBetween } from '../uber.js';
import { adminMenu } from '../lib/keyboards.js';
import { usd, fmtHourRange } from '../lib/format.js';

function ensureAdmin(ctx, chatId, telegramId) {
  if (!isAdminId(telegramId)) {
    ctx.bot.sendMessage(chatId, 'Admins only.');
    return false;
  }
  return true;
}

export async function showMenu(ctx, chatId, telegramId) {
  if (!ensureAdmin(ctx, chatId, telegramId)) return;
  await ctx.bot.sendMessage(chatId, '⚙️ *Admin panel*', {
    parse_mode: 'Markdown',
    ...adminMenu(),
  });
}

export async function showUsers(ctx, chatId, telegramId) {
  if (!ensureAdmin(ctx, chatId, telegramId)) return;
  const users = await listUsers();
  if (!users.length) {
    await ctx.bot.sendMessage(chatId, 'No users yet.');
    return;
  }
  const lines = users.map(
    (u) =>
      `• ${u.full_name || u.username || 'unknown'} — \`${u.telegram_id}\` — ${u.role}${
        u.active ? '' : ' (inactive)'
      }`
  );
  await ctx.bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
}

export async function promptAddExpert(ctx, chatId, telegramId) {
  if (!ensureAdmin(ctx, chatId, telegramId)) return;
  ctx.sessions.set(chatId, { flow: 'admin', step: 'awaiting_add_expert' });
  await ctx.bot.sendMessage(
    chatId,
    'Send the *Telegram numeric ID* of the user to make a LEGO expert.\n' +
      '(They must have tapped /start at least once.)',
    { parse_mode: 'Markdown' }
  );
}

export async function doAddExpert(ctx, chatId, text) {
  ctx.sessions.delete(chatId);
  const id = Number.parseInt(String(text).trim(), 10);
  if (Number.isNaN(id)) {
    await ctx.bot.sendMessage(chatId, 'That’s not a valid numeric Telegram ID.');
    return;
  }
  const existing = await getUserByTelegramId(id);
  if (!existing) {
    await ctx.bot.sendMessage(chatId, 'No user with that ID has started the bot yet.');
    return;
  }
  const updated = await setRole(id, 'expert');
  await setActive(id, true);
  await ctx.bot.sendMessage(
    chatId,
    `✅ ${updated.full_name || updated.username || id} is now an active expert.`
  );
  try {
    await ctx.bot.sendMessage(id, '🛠️ You’ve been added as a Heaux SF LEGO expert! Tap /start.');
  } catch {
    /* user hasn't opened the bot; ignore */
  }
}

export async function promptRemove(ctx, chatId, telegramId) {
  if (!ensureAdmin(ctx, chatId, telegramId)) return;
  ctx.sessions.set(chatId, { flow: 'admin', step: 'awaiting_remove' });
  await ctx.bot.sendMessage(
    chatId,
    'Send the *Telegram numeric ID* of the user to deactivate.',
    { parse_mode: 'Markdown' }
  );
}

export async function doRemove(ctx, chatId, text) {
  ctx.sessions.delete(chatId);
  const id = Number.parseInt(String(text).trim(), 10);
  if (Number.isNaN(id)) {
    await ctx.bot.sendMessage(chatId, 'That’s not a valid numeric Telegram ID.');
    return;
  }
  const updated = await setActive(id, false);
  if (!updated) {
    await ctx.bot.sendMessage(chatId, 'No user with that ID.');
    return;
  }
  await ctx.bot.sendMessage(chatId, `✅ Deactivated ${updated.full_name || id}.`);
}

// List open (unaccepted) bookings with an "assign a builder" affordance.
export async function showBookings(ctx, chatId, telegramId) {
  if (!ensureAdmin(ctx, chatId, telegramId)) return;
  const open = await listOpenBookings();
  if (!open.length) {
    await ctx.bot.sendMessage(chatId, 'No open bookings awaiting a builder.');
    return;
  }
  for (const b of open) {
    await ctx.bot.sendMessage(
      chatId,
      `🕑 ${fmtHourRange(b.slot_start, b.slot_end)}\n📍 ${b.customer_address}\n💵 Service ${usd(
        b.service_fee_cents
      )} (+ travel on accept)`,
      { reply_markup: { inline_keyboard: [[{ text: '👤 Assign a builder', callback_data: `adm:assign:${b.id}` }]] } }
    );
  }
}

// Step 1 of accept-on-behalf: choose which expert to assign.
export async function chooseExpertForBooking(ctx, chatId, telegramId, bookingId) {
  if (!ensureAdmin(ctx, chatId, telegramId)) return;
  const experts = await listExperts({ activeOnly: true });
  if (!experts.length) {
    await ctx.bot.sendMessage(chatId, 'No active experts to assign.');
    return;
  }
  const rows = experts.map((e) => [
    {
      text: e.full_name || e.username || String(e.telegram_id),
      callback_data: `adm:assignto:${bookingId}:${e.id}`,
    },
  ]);
  await ctx.bot.sendMessage(chatId, 'Assign this booking to:', {
    reply_markup: { inline_keyboard: rows },
  });
}

// Step 2: assign on behalf — prices travel from the chosen builder's address.
export async function assignExpert(ctx, chatId, telegramId, bookingId, expertId) {
  if (!ensureAdmin(ctx, chatId, telegramId)) return;
  const builder = await getUserById(expertId);
  const booking = await getBooking(bookingId);
  if (!booking || booking.status !== 'awaiting_acceptance') {
    await ctx.bot.sendMessage(chatId, 'That booking is no longer open.');
    return;
  }
  if (!builder?.address) {
    await ctx.bot.sendMessage(chatId, 'That builder has no base address set — they need to add one first.');
    return;
  }
  const est = await estimateBetween(builder.address, booking.customer_address);
  const surcharge = est.ok ? est.surchargeCents : config.uber.flatFallbackCents;
  const total = booking.service_fee_cents + surcharge;
  const accepted = await acceptOpenBooking(bookingId, expertId, { surchargeCents: surcharge, totalCents: total });
  if (!accepted) {
    await ctx.bot.sendMessage(chatId, 'That booking is no longer open.');
    return;
  }
  await ctx.bot.sendMessage(chatId, `✅ Assigned. Travel ${usd(surcharge)}; customer asked to pay ${usd(total)}.`);
  try {
    await ctx.bot.sendMessage(
      accepted.customer_telegram_id,
      `🎉 A builder was assigned for ${fmtHourRange(accepted.slot_start, accepted.slot_end)}!\n` +
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

// ── Inventory ────────────────────────────────────────────────────────
export async function showInventory(ctx, chatId, telegramId) {
  if (!ensureAdmin(ctx, chatId, telegramId)) return;
  const items = await listInventory();
  if (!items.length) {
    await ctx.bot.sendMessage(chatId, 'No inventory items.');
    return;
  }
  const rows = items.map((it) => [
    { text: `✏️ Set ${it.name} (now ${it.stock_qty})`, callback_data: `adm:stock:${it.sku}` },
  ]);
  const lines = items.map((it) => `• ${it.name} (\`${it.sku}\`): *${it.stock_qty}* in stock`);
  await ctx.bot.sendMessage(chatId, `📦 *Inventory*\n${lines.join('\n')}`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows },
  });
}

export async function promptSetStock(ctx, chatId, telegramId, sku) {
  if (!ensureAdmin(ctx, chatId, telegramId)) return;
  ctx.sessions.set(chatId, { flow: 'admin', step: 'awaiting_stock', data: { sku } });
  await ctx.bot.sendMessage(chatId, `Enter the new stock quantity for \`${sku}\`:`, {
    parse_mode: 'Markdown',
  });
}

export async function doSetStock(ctx, chatId, text) {
  const session = ctx.sessions.get(chatId);
  const sku = session?.data?.sku;
  ctx.sessions.delete(chatId);
  if (!sku) return;
  const qty = Number.parseInt(String(text).trim(), 10);
  if (Number.isNaN(qty) || qty < 0) {
    await ctx.bot.sendMessage(chatId, 'Please send a whole number (0 or more).');
    return;
  }
  const updated = await setStock(sku, qty);
  await ctx.bot.sendMessage(
    chatId,
    updated ? `✅ ${updated.name} stock set to ${updated.stock_qty}.` : 'SKU not found.'
  );
}

// ── Manual surcharge (option B) ──────────────────────────────────────
// Notify every admin that a booking needs a fare confirmed.
export async function notifyAdminsForFare(ctx, booking) {
  for (const adminId of config.adminIds) {
    try {
      await ctx.bot.sendMessage(
        adminId,
        `💸 Confirm Uber fare for booking at:\n📍 ${booking.customer_address}\n🕑 ${fmtHourRange(
          booking.slot_start,
          booking.slot_end
        )}`,
        {
          reply_markup: {
            inline_keyboard: [[{ text: 'Enter fare $', callback_data: `adm:fare:${booking.id}` }]],
          },
        }
      );
    } catch {
      /* admin hasn't opened the bot; ignore */
    }
  }
}

export async function promptFare(ctx, chatId, telegramId, bookingId) {
  if (!ensureAdmin(ctx, chatId, telegramId)) return;
  ctx.sessions.set(chatId, { flow: 'admin', step: 'awaiting_fare', data: { bookingId } });
  await ctx.bot.sendMessage(chatId, 'Enter the Uber fare in dollars (e.g. 14.50):');
}

export async function doSetFare(ctx, chatId, text) {
  const session = ctx.sessions.get(chatId);
  const bookingId = session?.data?.bookingId;
  ctx.sessions.delete(chatId);
  if (!bookingId) return;

  const surchargeCents = manualSurchargeCents(text);
  if (surchargeCents === null) {
    await ctx.bot.sendMessage(chatId, 'Couldn’t parse that amount. Try again from the booking.');
    return;
  }
  const booking = await getBooking(bookingId);
  if (!booking) {
    await ctx.bot.sendMessage(chatId, 'Booking not found.');
    return;
  }
  const total = booking.service_fee_cents + surchargeCents;
  const updated = await setBookingSurcharge(bookingId, {
    surchargeCents,
    source: 'manual',
    totalCents: total,
  });
  await ctx.bot.sendMessage(chatId, `✅ Fare set to ${usd(surchargeCents)}. Customer notified.`);
  try {
    await ctx.bot.sendMessage(
      updated.customer_telegram_id,
      `✅ Travel fare confirmed: ${usd(surchargeCents)}.\n` +
        `Total ${usd(total)} for ${fmtHourRange(updated.slot_start, updated.slot_end)}.`,
      {
        reply_markup: {
          inline_keyboard: [[{ text: `Pay ${usd(total)}`, callback_data: `book:pay:${bookingId}` }]],
        },
      }
    );
  } catch {
    /* ignore */
  }
}
