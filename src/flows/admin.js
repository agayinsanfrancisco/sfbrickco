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
  addBuilderInvite,
  listInventory,
  setStock,
  listPaidUndispatchedOrders,
  listRecentOrders,
  markOrderRefunded,
  markBookingRefunded,
  setSetting,
  getInventory,
  setProductPrice,
  createProduct,
} from '../supabase.js';
import { manualSurchargeCents, estimateBetween } from '../uber.js';
import { adminMenu } from '../lib/keyboards.js';
import { usd, fmtHourRange, shortRef } from '../lib/format.js';
import { getIntSetting, invalidateSettings } from '../lib/settings.js';

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
  const PAGE = 50; // cap to stay well under Telegram's message limit (#47)
  const shown = users.slice(0, PAGE);
  const lines = shown.map(
    (u) =>
      `• ${u.full_name || u.username || 'unknown'} — \`${u.telegram_id}\` — ${u.role}${
        u.active ? '' : ' (inactive)'
      }`
  );
  if (users.length > PAGE) lines.push(`\n_…and ${users.length - PAGE} more (showing first ${PAGE})._`);
  await ctx.bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
}

export async function promptAddExpert(ctx, chatId, telegramId) {
  if (!ensureAdmin(ctx, chatId, telegramId)) return;
  ctx.sessions.set(chatId, { flow: 'admin', step: 'awaiting_add_expert' });
  await ctx.bot.sendMessage(
    chatId,
    'Send the builder’s *@handle* (Telegram username).\n' +
      'They’ll become an active builder the moment they open the bot and tap /builder.',
    { parse_mode: 'Markdown' }
  );
}

export async function doAddExpert(ctx, chatId, text) {
  ctx.sessions.delete(chatId);
  const handle = await addBuilderInvite(text);
  if (!handle) {
    await ctx.bot.sendMessage(chatId, 'That doesn’t look like a valid @handle. Try again.');
    return;
  }
  await ctx.bot.sendMessage(
    chatId,
    `✅ Invited *@${handle}* as a builder. They’ll be activated automatically when they open the bot and tap /builder.`,
    { parse_mode: 'Markdown' }
  );
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

// ── Open orders (paid, awaiting dispatch) (#12) ──────────────────────
export async function showOpenOrders(ctx, chatId, telegramId) {
  if (!ensureAdmin(ctx, chatId, telegramId)) return;
  const orders = await listPaidUndispatchedOrders();
  if (!orders.length) {
    await ctx.bot.sendMessage(chatId, 'No paid orders awaiting dispatch.');
    return;
  }
  for (const o of orders) {
    const total = (o.amount_cents || 0) + (o.delivery_fee_cents || 0);
    await ctx.bot.sendMessage(
      chatId,
      `📦 *${shortRef(o.id)}* — ${o.qty}× ${o.sku}\n📍 ${o.delivery_address}\n📞 ${o.contact_phone || '—'}` +
        `${o.notes ? `\n📝 ${o.notes}` : ''}\n${usd(total)}`,
      {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🚚 Accept & dispatch', callback_data: `pm:disp:${o.id}` }]] },
      }
    );
  }
}

// ── Broadcast (#28) ──────────────────────────────────────────────────
export async function promptBroadcast(ctx, chatId, telegramId) {
  if (!ensureAdmin(ctx, chatId, telegramId)) return;
  ctx.sessions.set(chatId, { flow: 'admin', step: 'awaiting_broadcast' });
  await ctx.bot.sendMessage(chatId, 'Send the message to broadcast to all customers (or /start to cancel):');
}

export async function doBroadcast(ctx, chatId, text) {
  ctx.sessions.delete(chatId);
  const users = await listUsers();
  let sent = 0;
  let failed = 0;
  for (const u of users) {
    try {
      await ctx.bot.sendMessage(u.telegram_id, `📣 ${text}`);
      sent++;
    } catch {
      failed++;
    }
  }
  await ctx.bot.sendMessage(chatId, `✅ Broadcast sent to ${sent} user(s)${failed ? `, ${failed} unreachable` : ''}.`);
}

// ── Order lookup by ref (#38) ────────────────────────────────────────
export async function promptFindOrder(ctx, chatId, telegramId) {
  if (!ensureAdmin(ctx, chatId, telegramId)) return;
  ctx.sessions.set(chatId, { flow: 'admin', step: 'awaiting_find_order' });
  await ctx.bot.sendMessage(chatId, 'Send an order ref (e.g. SFB-3F9A2C):');
}

export async function doFindOrder(ctx, chatId, text) {
  ctx.sessions.delete(chatId);
  const key = String(text).toUpperCase().replace(/[^0-9A-F]/g, '').slice(0, 6);
  if (key.length < 4) {
    await ctx.bot.sendMessage(chatId, 'That doesn’t look like a ref. Try e.g. SFB-3F9A2C.');
    return;
  }
  const orders = await listRecentOrders(500);
  const o = orders.find((x) => shortRef(x.id).replace('SFB-', '') === key);
  if (!o) {
    await ctx.bot.sendMessage(chatId, 'No matching order found.');
    return;
  }
  const total = (o.amount_cents || 0) + (o.delivery_fee_cents || 0);
  const canRefund = ['paid', 'dispatched', 'delivered'].includes(o.status);
  await ctx.bot.sendMessage(
    chatId,
    `🧾 *${shortRef(o.id)}*\n${o.qty}× ${o.sku} · ${usd(total)}\nStatus: *${o.status}*\n` +
      `📍 ${o.delivery_address || '—'}\n📞 ${o.contact_phone || '—'}` +
      `${o.notes ? `\n📝 ${o.notes}` : ''}${o.pay_txid ? `\n🔗 \`${o.pay_txid}\`` : ''}`,
    {
      parse_mode: 'Markdown',
      reply_markup: canRefund
        ? { inline_keyboard: [[{ text: '↩️ Mark refunded', callback_data: `adm:refundo:${o.id}` }]] }
        : undefined,
    }
  );
}

// ── Refund recording (#37) ───────────────────────────────────────────
export async function promptRefund(ctx, chatId, telegramId, kind, ref) {
  if (!ensureAdmin(ctx, chatId, telegramId)) return;
  ctx.sessions.set(chatId, { flow: 'admin', step: 'awaiting_refund_txid', data: { kind, ref } });
  await ctx.bot.sendMessage(chatId, 'Send the refund transaction id (or type "none"):');
}

export async function doRefund(ctx, chatId, text) {
  const session = ctx.sessions.get(chatId);
  const { kind, ref } = session?.data || {};
  ctx.sessions.delete(chatId);
  if (!ref) return;
  const txid = String(text).trim().toLowerCase() === 'none' ? null : String(text).trim();
  const row = kind === 'o' ? await markOrderRefunded(ref, txid) : await markBookingRefunded(ref, txid);
  if (!row) {
    await ctx.bot.sendMessage(chatId, 'Couldn’t mark that refunded.');
    return;
  }
  await ctx.bot.sendMessage(chatId, `↩️ Marked refunded${txid ? ` (tx ${txid})` : ''}.`);
  const customerId = kind === 'o' ? row.telegram_id : row.customer_telegram_id;
  try {
    await ctx.bot.sendMessage(customerId, `↩️ Your ${kind === 'o' ? 'order' : 'booking'} ${shortRef(ref)} has been refunded.`);
  } catch {
    /* ignore */
  }
}

// ── Editable fees (#44) ──────────────────────────────────────────────
export async function showFees(ctx, chatId, telegramId) {
  if (!ensureAdmin(ctx, chatId, telegramId)) return;
  const [service, base, perMile] = await Promise.all([
    getIntSetting('service_fee_cents', config.pricing.serviceFeeCents),
    getIntSetting('uber_base_cents', config.uber.baseCents),
    getIntSetting('uber_per_mile_cents', config.uber.perMileCents),
  ]);
  await ctx.bot.sendMessage(
    chatId,
    `💲 *Fees*\n• Service fee: ${usd(service)}\n• Travel base: ${usd(base)}\n• Per mile: ${usd(perMile)}`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Edit service fee', callback_data: 'adm:fee:service' }],
          [{ text: 'Edit travel base', callback_data: 'adm:fee:base' }],
          [{ text: 'Edit per-mile', callback_data: 'adm:fee:permile' }],
        ],
      },
    }
  );
}

const FEE_KEYS = { service: 'service_fee_cents', base: 'uber_base_cents', permile: 'uber_per_mile_cents' };

export async function promptSetFee(ctx, chatId, telegramId, which) {
  if (!ensureAdmin(ctx, chatId, telegramId)) return;
  if (!FEE_KEYS[which]) return;
  ctx.sessions.set(chatId, { flow: 'admin', step: 'awaiting_fee', data: { which } });
  await ctx.bot.sendMessage(chatId, `Enter the new amount in dollars for *${which}* (e.g. 50):`, {
    parse_mode: 'Markdown',
  });
}

export async function doSetFee(ctx, chatId, text) {
  const session = ctx.sessions.get(chatId);
  const which = session?.data?.which;
  ctx.sessions.delete(chatId);
  const key = FEE_KEYS[which];
  if (!key) return;
  const dollars = Number.parseFloat(String(text).replace(/[^0-9.]/g, ''));
  if (Number.isNaN(dollars) || dollars < 0) {
    await ctx.bot.sendMessage(chatId, 'Please enter a valid non-negative amount.');
    return;
  }
  await setSetting(key, Math.round(dollars * 100));
  invalidateSettings();
  await ctx.bot.sendMessage(chatId, `✅ ${which} set to ${usd(Math.round(dollars * 100))}.`);
}

// ── Price editing + add SKU (#29) ────────────────────────────────────
export async function promptSetPrice(ctx, chatId, telegramId, sku) {
  if (!ensureAdmin(ctx, chatId, telegramId)) return;
  ctx.sessions.set(chatId, { flow: 'admin', step: 'awaiting_price', data: { sku } });
  await ctx.bot.sendMessage(
    chatId,
    `Enter the new price for \`${sku}\` as: *unit* [*bundleQty* *bundlePrice*]\n` +
      `e.g. \`10\` or \`10 6 45\` (= $10 each, 6 for $45).`,
    { parse_mode: 'Markdown' }
  );
}

export async function doSetPrice(ctx, chatId, text) {
  const session = ctx.sessions.get(chatId);
  const sku = session?.data?.sku;
  ctx.sessions.delete(chatId);
  if (!sku) return;
  const parts = String(text).trim().split(/\s+/).map((n) => Number.parseFloat(n));
  const [unit, bundleQty, bundlePrice] = parts;
  if (Number.isNaN(unit) || unit < 0) {
    await ctx.bot.sendMessage(chatId, 'Couldn’t parse the unit price. Try again from the inventory.');
    return;
  }
  const patch = { unitPriceCents: Math.round(unit * 100) };
  if (!Number.isNaN(bundleQty) && !Number.isNaN(bundlePrice)) {
    patch.bundleQty = Math.round(bundleQty);
    patch.bundlePriceCents = Math.round(bundlePrice * 100);
  }
  const updated = await setProductPrice(sku, patch);
  await ctx.bot.sendMessage(
    chatId,
    updated ? `✅ ${updated.name} priced at ${usd(updated.unit_price_cents)} each.` : 'SKU not found.'
  );
}

export async function promptAddSku(ctx, chatId, telegramId) {
  if (!ensureAdmin(ctx, chatId, telegramId)) return;
  ctx.sessions.set(chatId, { flow: 'admin', step: 'awaiting_add_sku' });
  await ctx.bot.sendMessage(
    chatId,
    'Add a product as: `sku | Name | unitDollars`\ne.g. `red-2x4 | Red 2x4 brick | 3.50`',
    { parse_mode: 'Markdown' }
  );
}

export async function doAddSku(ctx, chatId, text) {
  ctx.sessions.delete(chatId);
  const [sku, name, price] = String(text).split('|').map((s) => s.trim());
  const dollars = Number.parseFloat(price);
  if (!sku || !name || Number.isNaN(dollars) || dollars < 0) {
    await ctx.bot.sendMessage(chatId, 'Format: `sku | Name | unitDollars`. Try again.', { parse_mode: 'Markdown' });
    return;
  }
  try {
    const p = await createProduct({ sku, name, unitPriceCents: Math.round(dollars * 100) });
    await ctx.bot.sendMessage(chatId, `✅ Added *${p.name}* (\`${p.sku}\`) at ${usd(p.unit_price_cents)}. Set stock from the inventory menu.`, {
      parse_mode: 'Markdown',
    });
  } catch (err) {
    await ctx.bot.sendMessage(chatId, `Couldn’t add it: ${err.message}`);
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
    { text: `📦 Stock ${it.name} (${it.stock_qty})`, callback_data: `adm:stock:${it.sku}` },
    { text: `💲 Price`, callback_data: `adm:price:${it.sku}` },
  ]);
  rows.push([{ text: '➕ Add product', callback_data: 'adm:addsku' }]);
  const lines = items.map(
    (it) =>
      `• ${it.name} (\`${it.sku}\`): *${it.stock_qty}* in stock · ${usd(it.unit_price_cents || 0)} ea${
        it.active ? '' : ' (hidden)'
      }`
  );
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
