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
  repeatCustomers,
  builderPayoutData,
  recordPayout,
  exportRows,
  listInventory,
  setStock,
  listPaidUndispatchedOrders,
  listRecentOrders,
  markOrderRefunded,
  markBookingRefunded,
  listAwaitingPaymentBookings,
  setSetting,
  getInventory,
  setProductPrice,
  createProduct,
  createPromo,
  listPendingApplications,
  setApplicationStatus,
  promoteToExpert,
  setUserRate,
  setUserAddress,
  setExpertAvailability,
  getExpertAvailability,
} from '../supabase.js';
import { manualSurchargeCents, estimateBetween } from '../uber.js';
import { effectiveRole, can, canChangeRoleOf, assignableRoles, displayName, displayPhone, ROLE_LABELS, isStaff } from '../lib/roles.js';
import { adminMenu, adminCategory } from '../lib/keyboards.js';
import { usd, fmtHourRange, shortRef, orderItemsSummary } from '../lib/format.js';
import { getIntSetting, getBoolSetting, invalidateSettings } from '../lib/settings.js';

// Resolve the caller's effective staff role: env owners win, then DB role.
export async function resolveRole(telegramId) {
  if (isAdminId(telegramId)) return 'owner';
  return effectiveRole(await getUserByTelegramId(telegramId));
}

// Capability gate. Returns the caller's role (truthy) or null after telling
// them they don't have access.
async function ensureCap(ctx, chatId, telegramId, cap) {
  const role = await resolveRole(telegramId);
  if (!can(role, cap)) {
    await ctx.bot.sendMessage(chatId, '🔒 You don’t have access to that.');
    return null;
  }
  return role;
}

export async function showMenu(ctx, chatId, telegramId) {
  const role = await ensureCap(ctx, chatId, telegramId, 'panel');
  if (!role) return;
  await ctx.bot.sendMessage(
    chatId,
    `⚙️ *Staff panel* (${ROLE_LABELS[role]})\nPick a category.`,
    { parse_mode: 'Markdown', ...adminMenu(role) }
  );
}

// Open one owner-panel category (drill-down from showMenu).
export async function showCategory(ctx, chatId, telegramId, cat) {
  const role = await ensureCap(ctx, chatId, telegramId, 'panel');
  if (!role) return;
  const kb = adminCategory(cat, role);
  if (!kb) return;
  await ctx.bot.sendMessage(chatId, `*${kb.title}*`, { parse_mode: 'Markdown', reply_markup: kb.reply_markup });
}

export async function showUsers(ctx, chatId, telegramId) {
  const role = await ensureCap(ctx, chatId, telegramId, 'view_users');
  if (!role) return;
  const users = await listUsers();
  if (!users.length) {
    await ctx.bot.sendMessage(chatId, 'No users yet.');
    return;
  }
  const PAGE = 50; // cap to stay well under Telegram's message limit (#47)
  const shown = users.slice(0, PAGE);
  const lines = shown.map(
    (u) =>
      `• ${displayName(role, u.full_name) || u.username || 'unknown'} — \`${u.telegram_id}\` — ${ROLE_LABELS[u.role] || u.role}${
        u.active ? '' : ' (inactive)'
      }`
  );
  if (users.length > PAGE) lines.push(`\n_…and ${users.length - PAGE} more (showing first ${PAGE})._`);
  await ctx.bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
}

export async function promptAddExpert(ctx, chatId, telegramId) {
  const role = await ensureCap(ctx, chatId, telegramId, 'manage_experts');
  if (!role) return;
  ctx.sessions.set(chatId, { flow: 'admin', step: 'awaiting_add_expert' });
  await ctx.bot.sendMessage(
    chatId,
    'Send the Block Expert’s *@handle* (Telegram username).\n' +
      'They’ll become an active Block Expert the moment they open the bot and tap /builder.',
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
    `✅ Invited *@${handle}* as a Block Expert. They’ll be activated automatically when they open the bot and tap /builder.`,
    { parse_mode: 'Markdown' }
  );
}

export async function promptRemove(ctx, chatId, telegramId) {
  const role = await ensureCap(ctx, chatId, telegramId, 'manage_roles');
  if (!role) return;
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
  const role = await ensureCap(ctx, chatId, telegramId, 'manage_experts');
  if (!role) return;
  const [open, awaitingPay] = await Promise.all([listOpenBookings(), listAwaitingPaymentBookings()]);
  if (!open.length && !awaitingPay.length) {
    await ctx.bot.sendMessage(chatId, 'No open or awaiting-payment bookings.');
    return;
  }
  for (const b of open) {
    await ctx.bot.sendMessage(
      chatId,
      `🕑 ${fmtHourRange(b.slot_start, b.slot_end)}\n📍 ${b.customer_address}\n💵 Service ${usd(
        b.service_fee_cents
      )} (+ travel on accept)`,
      { reply_markup: { inline_keyboard: [[{ text: '👤 Assign a Block Expert', callback_data: `adm:assign:${b.id}` }]] } }
    );
  }
  for (const b of awaitingPay) {
    await ctx.bot.sendMessage(
      chatId,
      `⏳ *Awaiting payment* — ${shortRef(b.id)}\n🕑 ${fmtHourRange(b.slot_start, b.slot_end)}\n📍 ${b.customer_address}\n` +
        `💵 Total ${usd(b.total_cents)} (service ${usd(b.service_fee_cents)} + travel ${usd(b.surcharge_cents)})`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '✅ Log payment (paid another way)', callback_data: `pm:ok:b:${b.id}` }]],
        },
      }
    );
  }
}

// Step 1 of accept-on-behalf: choose which expert to assign.
export async function chooseExpertForBooking(ctx, chatId, telegramId, bookingId) {
  const role = await ensureCap(ctx, chatId, telegramId, 'manage_experts');
  if (!role) return;
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

// Step 2: assign on behalf. Travel/total are already fixed on the booking.
export async function assignExpert(ctx, chatId, telegramId, bookingId, expertId) {
  const role = await ensureCap(ctx, chatId, telegramId, 'manage_experts');
  if (!role) return;
  const booking = await getBooking(bookingId);
  if (!booking || booking.status !== 'awaiting_acceptance') {
    await ctx.bot.sendMessage(chatId, 'That booking is no longer open.');
    return;
  }
  const accepted = await acceptOpenBooking(bookingId, expertId);
  if (!accepted) {
    await ctx.bot.sendMessage(chatId, 'That booking is no longer open.');
    return;
  }
  await ctx.bot.sendMessage(
    chatId,
    `✅ Assigned. Customer asked to pay ${usd(accepted.total_cents)}.`,
    {
      reply_markup: {
        inline_keyboard: [[{ text: '✅ Log payment (paid another way)', callback_data: `pm:ok:b:${bookingId}` }]],
      },
    }
  );
  // Notify the assigned Block Expert (they didn't self-accept, so tell them).
  const builder = await getUserById(expertId);
  if (builder) {
    const travel = accepted.customer_books_ride
      ? 'Customer books your ride.'
      : `${usd(accepted.surcharge_cents)} travel included.`;
    try {
      await ctx.bot.sendMessage(
        builder.telegram_id,
        `📋 You’ve been assigned a job for ${fmtHourRange(accepted.slot_start, accepted.slot_end)}.\n` +
          `📍 ${accepted.customer_address}\n${travel} Total ${usd(accepted.total_cents)} — awaiting customer payment.`
      );
    } catch {
      /* Block Expert hasn't opened the bot */
    }
  }
  try {
    await ctx.bot.sendMessage(
      accepted.customer_telegram_id,
      `🎉 A Block Expert was assigned for ${fmtHourRange(accepted.slot_start, accepted.slot_end)}!\n` +
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

// ── Open orders (paid, awaiting dispatch) (#12) ──────────────────────
export async function showOpenOrders(ctx, chatId, telegramId) {
  const role = await ensureCap(ctx, chatId, telegramId, 'manage_orders');
  if (!role) return;
  const orders = await listPaidUndispatchedOrders();
  if (!orders.length) {
    await ctx.bot.sendMessage(chatId, 'No paid orders awaiting dispatch.');
    return;
  }
  for (const o of orders) {
    const total = (o.amount_cents || 0) + (o.delivery_fee_cents || 0);
    await ctx.bot.sendMessage(
      chatId,
      `📦 *${shortRef(o.id)}* — ${orderItemsSummary(o)}\n📍 ${o.delivery_address}\n📞 ${displayPhone(role, o.contact_phone)}` +
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
  const role = await ensureCap(ctx, chatId, telegramId, 'broadcast');
  if (!role) return;
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
  const role = await ensureCap(ctx, chatId, telegramId, 'manage_orders');
  if (!role) return;
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
  const total = (o.amount_cents || 0) + (o.delivery_fee_cents || 0) - (o.discount_cents || 0);
  const rows = [];
  if (o.status === 'pending') {
    rows.push([{ text: '✅ Log payment (paid another way)', callback_data: `pm:ok:o:${o.id}` }]);
  }
  if (['paid', 'dispatched', 'delivered'].includes(o.status)) {
    rows.push([{ text: '↩️ Mark refunded', callback_data: `adm:refundo:${o.id}` }]);
  }
  await ctx.bot.sendMessage(
    chatId,
    `🧾 *${shortRef(o.id)}*\n${orderItemsSummary(o)} · ${usd(total)}\nStatus: *${o.status}*\n` +
      `📍 ${o.delivery_address || '—'}\n📞 ${displayPhone(role, o.contact_phone)}` +
      `${o.notes ? `\n📝 ${o.notes}` : ''}${o.pay_txid ? `\n🔗 \`${o.pay_txid}\`` : ''}`,
    {
      parse_mode: 'Markdown',
      reply_markup: rows.length ? { inline_keyboard: rows } : undefined,
    }
  );
}

// ── Refund recording (#37) ───────────────────────────────────────────
export async function promptRefund(ctx, chatId, telegramId, kind, ref) {
  const role = await ensureCap(ctx, chatId, telegramId, 'refunds');
  if (!role) return;
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

// ── Builder payouts ──────────────────────────────────────────────────
// Owed = net of all PAID bookings (rate minus the platform fee) minus what's
// already been paid out. "Mark paid" records the transfer (you send the funds
// however you like — this is the ledger).
export async function showPayouts(ctx, chatId, telegramId) {
  const role = await ensureCap(ctx, chatId, telegramId, 'payouts');
  if (!role) return;
  const { earned, paid } = await builderPayoutData();
  const fee = config.pricing.platformFeePct;
  const byExpert = new Map();
  for (const b of earned) {
    const cur = byExpert.get(b.expert_id) || { gross: 0, paidOut: 0, jobs: 0 };
    cur.gross += b.service_fee_cents || 0;
    cur.jobs += 1;
    byExpert.set(b.expert_id, cur);
  }
  for (const p of paid) {
    const cur = byExpert.get(p.expert_id) || { gross: 0, paidOut: 0, jobs: 0 };
    cur.paidOut += p.amount_cents || 0;
    byExpert.set(p.expert_id, cur);
  }
  if (!byExpert.size) {
    await ctx.bot.sendMessage(chatId, 'No paid bookings yet — nothing to pay out.');
    return;
  }
  const lines = [];
  const rows = [];
  for (const [expertId, v] of byExpert) {
    const u = await getUserById(expertId);
    const name = u?.full_name || (u?.username ? `@${u.username}` : expertId.slice(0, 8));
    const net = Math.round((v.gross * (100 - fee)) / 100);
    const owed = Math.max(0, net - v.paidOut);
    lines.push(`• ${name}: ${v.jobs} job${v.jobs === 1 ? '' : 's'} · earned ${usd(net)} · paid ${usd(v.paidOut)} · owed *${usd(owed)}*`);
    if (owed > 0) rows.push([{ text: `💸 Pay ${name} ${usd(owed)}`, callback_data: `adm:payout:${expertId}:${owed}` }]);
  }
  rows.push([{ text: '⬅️ Back to panel', callback_data: 'adm:menu' }]);
  await ctx.bot.sendMessage(
    chatId,
    `💸 *Builder payouts* (after the ${fee}% platform fee)\n\n${lines.join('\n')}\n\nTap to record a payout once you’ve sent the funds:`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } }
  );
}

export async function doPayout(ctx, chatId, telegramId, expertId, amountCents) {
  const role = await ensureCap(ctx, chatId, telegramId, 'payouts');
  if (!role) return;
  const amount = Number.parseInt(amountCents, 10);
  if (!Number.isInteger(amount) || amount <= 0) return;
  await recordPayout(expertId, amount, 'owner-marked');
  const u = await getUserById(expertId);
  await ctx.bot.sendMessage(chatId, `✅ Recorded ${usd(amount)} payout to ${u?.full_name || 'builder'}.`);
  try {
    if (u) await ctx.bot.sendMessage(u.telegram_id, `💸 You’ve been paid *${usd(amount)}* — check your wallet/account. Thanks for building with us!`, { parse_mode: 'Markdown' });
  } catch {
    /* ignore */
  }
  await showPayouts(ctx, chatId, telegramId);
}

// ── CSV export (orders + bookings, for bookkeeping) ──────────────────
function toCsv(rows, columns) {
  const esc = (v) => {
    const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\n');
}

export async function exportCsv(ctx, chatId, telegramId) {
  const role = await ensureCap(ctx, chatId, telegramId, 'reports');
  if (!role) return;
  const { orders, bookings } = await exportRows();
  const orderCols = ['id', 'created_at', 'telegram_id', 'sku', 'qty', 'amount_cents', 'delivery_fee_cents', 'discount_cents', 'status', 'payment_method', 'pay_coin', 'crypto_amount', 'pay_txid', 'delivery_address'];
  const bookingCols = ['id', 'created_at', 'customer_telegram_id', 'expert_id', 'slot_start', 'slot_end', 'service_fee_cents', 'surcharge_cents', 'total_cents', 'payment_status', 'status', 'pay_coin', 'crypto_amount', 'pay_txid', 'customer_address'];
  const stamp = new Date().toISOString().slice(0, 10);
  await ctx.bot.sendDocument(
    chatId,
    Buffer.from(toCsv(orders, orderCols), 'utf8'),
    {},
    { filename: `orders-${stamp}.csv`, contentType: 'text/csv' }
  );
  await ctx.bot.sendDocument(
    chatId,
    Buffer.from(toCsv(bookings, bookingCols), 'utf8'),
    {},
    { filename: `bookings-${stamp}.csv`, contentType: 'text/csv' }
  );
}

// ── Repeat-customer report ───────────────────────────────────────────
export async function showRepeatCustomers(ctx, chatId, telegramId) {
  const role = await ensureCap(ctx, chatId, telegramId, 'reports');
  if (!role) return;
  const rows = await repeatCustomers(2);
  if (!rows.length) {
    await ctx.bot.sendMessage(chatId, 'No repeat customers yet — no one has 2+ paid bookings.');
    return;
  }
  const lines = rows
    .slice(0, 25)
    .map((r, i) => `${i + 1}. ${r.name} — *${r.count}* bookings · ${usd(r.spentCents)} total`);
  await ctx.bot.sendMessage(
    chatId,
    `🔁 *Repeat customers* (2+ paid bookings)\n_Loyalty + off-platform watch list._\n\n${lines.join('\n')}`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '⬅️ Back to panel', callback_data: 'adm:menu' }]] },
    }
  );
}

// ── Editable fees (#44) ──────────────────────────────────────────────
export async function showFees(ctx, chatId, telegramId) {
  const role = await ensureCap(ctx, chatId, telegramId, 'settings');
  if (!role) return;
  const [service, base, perMile, pct, cap, qty] = await Promise.all([
    getIntSetting('service_fee_cents', config.pricing.serviceFeeCents),
    getIntSetting('uber_base_cents', config.uber.baseCents),
    getIntSetting('uber_per_mile_cents', config.uber.perMileCents),
    getIntSetting('deposit_bonus_pct', 0),
    getIntSetting('deposit_bonus_cap_cents', 0),
    getIntSetting('bonus_qualifying_qty', 6),
  ]);
  const bonusLine =
    pct > 0
      ? `${pct}% of first deposit${cap > 0 ? `, up to ${usd(cap)}` : ''} — unlocked by a ${qty}-pack (once/customer)`
      : 'off';
  await ctx.bot.sendMessage(
    chatId,
    `💲 *Fees*\n• Service fee: ${usd(service)}\n• Travel base: ${usd(base)}\n• Per mile: ${usd(perMile)}\n` +
      `• 🎁 Deposit bonus: ${bonusLine}`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Edit service fee', callback_data: 'adm:fee:service' }],
          [{ text: 'Edit travel base', callback_data: 'adm:fee:base' }],
          [{ text: 'Edit per-mile', callback_data: 'adm:fee:permile' }],
          [{ text: '🎁 Edit bonus %', callback_data: 'adm:fee:bonuspct' }],
          [{ text: '🎁 Edit bonus cap', callback_data: 'adm:fee:bonuscap' }],
          [{ text: '🎁 Edit unlock pack size', callback_data: 'adm:fee:bonusqty' }],
          [{ text: '⬅️ Back to panel', callback_data: 'adm:menu' }],
        ],
      },
    }
  );
}

// Dollar-denominated settings (input in dollars, stored as cents).
const FEE_KEYS = {
  service: 'service_fee_cents',
  base: 'uber_base_cents',
  permile: 'uber_per_mile_cents',
  bonuscap: 'deposit_bonus_cap_cents',
};

// Raw-integer settings (input stored verbatim — a percent or a count).
const INT_KEYS = {
  bonuspct: 'deposit_bonus_pct',
  bonusqty: 'bonus_qualifying_qty',
};

export async function promptSetFee(ctx, chatId, telegramId, which) {
  const role = await ensureCap(ctx, chatId, telegramId, 'settings');
  if (!role) return;
  if (!FEE_KEYS[which] && !INT_KEYS[which]) return;
  ctx.sessions.set(chatId, { flow: 'admin', step: 'awaiting_fee', data: { which } });
  const unit = INT_KEYS[which]
    ? which === 'bonuspct'
      ? 'a percentage (e.g. 50)'
      : 'a whole number (e.g. 6)'
    : 'dollars (e.g. 50)';
  await ctx.bot.sendMessage(chatId, `Enter the new value for *${which}* — ${unit}:`, {
    parse_mode: 'Markdown',
  });
}

export async function doSetFee(ctx, chatId, text) {
  const session = ctx.sessions.get(chatId);
  const which = session?.data?.which;
  ctx.sessions.delete(chatId);
  const raw = Number.parseFloat(String(text).replace(/[^0-9.]/g, ''));
  if (Number.isNaN(raw) || raw < 0) {
    await ctx.bot.sendMessage(chatId, 'Please enter a valid non-negative number.');
    return;
  }
  if (INT_KEYS[which]) {
    const value = Math.round(raw);
    await setSetting(INT_KEYS[which], value);
    invalidateSettings();
    await ctx.bot.sendMessage(chatId, `✅ ${which} set to ${value}.`);
    return;
  }
  if (!FEE_KEYS[which]) return;
  await setSetting(FEE_KEYS[which], Math.round(raw * 100));
  invalidateSettings();
  await ctx.bot.sendMessage(chatId, `✅ ${which} set to ${usd(Math.round(raw * 100))}.`);
}

// ── Price editing + add SKU (#29) ────────────────────────────────────
export async function promptSetPrice(ctx, chatId, telegramId, sku) {
  const role = await ensureCap(ctx, chatId, telegramId, 'catalog');
  if (!role) return;
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
  const role = await ensureCap(ctx, chatId, telegramId, 'catalog');
  if (!role) return;
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

// ── Block Expert applications (approval flow) ───────────────────────
export async function showApplications(ctx, chatId, telegramId) {
  const role = await ensureCap(ctx, chatId, telegramId, 'approve_applications');
  if (!role) return;
  const apps = await listPendingApplications();
  if (!apps.length) {
    await ctx.bot.sendMessage(chatId, 'No pending Block Expert applications.');
    return;
  }
  for (const a of apps) {
    await ctx.bot.sendMessage(
      chatId,
      `🧰 *Application*\n👤 ${a.name}${a.username ? ` (@${a.username})` : ''}\n` +
        `🕑 ${a.hours}\n💲 ${a.rate}\n📞 ${a.phone || '—'}\n📍 ${a.base_address}`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Approve', callback_data: `adm:appok:${a.id}` },
              { text: '❌ Reject', callback_data: `adm:appno:${a.id}` },
            ],
          ],
        },
      }
    );
  }
}

export async function approveApplication(ctx, chatId, telegramId, appId) {
  const role = await ensureCap(ctx, chatId, telegramId, 'approve_applications');
  if (!role) return;
  const app = await setApplicationStatus(appId, 'approved');
  if (!app) {
    await ctx.bot.sendMessage(chatId, 'That application was already handled.');
    return;
  }
  const user = await promoteToExpert(app.telegram_id, app.base_address);
  await ctx.bot.sendMessage(
    chatId,
    user
      ? `✅ Approved *${app.name}* as a Block Expert (base ${app.base_address}).`
      : `✅ Approved — but ${app.name} must open the bot (/start) once before activation takes effect.`,
    { parse_mode: 'Markdown' }
  );
  try {
    await ctx.bot.sendMessage(
      app.telegram_id,
      '🎉 *You’re approved as a Block Expert!*\n\n' +
        'Two quick steps to start getting booked:\n' +
        '① Tap /builder → *🗓️ Availability* and turn on the hours you want to work.\n' +
        '② Confirm your *📍 base address* (used to price travel) and *💲 your rate*.\n\n' +
        'Customers can then book you directly during your hours. You keep your contact private until a job is paid — coordinate through the bot.',
      { parse_mode: 'Markdown' }
    );
  } catch {
    /* ignore */
  }
}

export async function rejectApplication(ctx, chatId, telegramId, appId) {
  const role = await ensureCap(ctx, chatId, telegramId, 'approve_applications');
  if (!role) return;
  const app = await setApplicationStatus(appId, 'rejected');
  if (!app) {
    await ctx.bot.sendMessage(chatId, 'That application was already handled.');
    return;
  }
  await ctx.bot.sendMessage(chatId, `❌ Rejected ${app.name}.`);
  try {
    await ctx.bot.sendMessage(
      app.telegram_id,
      'Thanks for applying to be a Block Expert — we’re not able to move forward at this time.'
    );
  } catch {
    /* ignore */
  }
}

// ── Feature flags (#46) ──────────────────────────────────────────────
const FLAGS = [
  { key: 'flag_shop', label: 'Shop' },
  { key: 'flag_booking', label: 'Booking' },
  { key: 'flag_wallet', label: 'Wallet' },
];

async function featuresKeyboard() {
  const states = await Promise.all(FLAGS.map((f) => getBoolSetting(f.key, true)));
  const rows = FLAGS.map((f, i) => [
    { text: `${states[i] ? '🟢' : '🔴'} ${f.label} — ${states[i] ? 'on' : 'off'}`, callback_data: `adm:flag:${f.key}` },
  ]);
  rows.push([{ text: '⬅️ Back to panel', callback_data: 'adm:menu' }]);
  return { inline_keyboard: rows };
}

export async function showFeatures(ctx, chatId, telegramId) {
  const role = await ensureCap(ctx, chatId, telegramId, 'settings');
  if (!role) return;
  await ctx.bot.sendMessage(
    chatId,
    '🎚️ *Features*\nTap to turn a section on or off for customers. Off = hidden + blocked.',
    { parse_mode: 'Markdown', reply_markup: await featuresKeyboard() }
  );
}

// Toggle a flag and update the same message in place (no message spam).
export async function toggleFlag(ctx, chatId, telegramId, key, messageId) {
  const role = await ensureCap(ctx, chatId, telegramId, 'settings');
  if (!role) return;
  if (!FLAGS.some((f) => f.key === key)) return;
  const current = await getBoolSetting(key, true);
  await setSetting(key, current ? 'off' : 'on');
  invalidateSettings();
  try {
    await ctx.bot.editMessageReplyMarkup(await featuresKeyboard(), { chat_id: chatId, message_id: messageId });
  } catch {
    await showFeatures(ctx, chatId, telegramId);
  }
}

// ── Promo codes (#19) ────────────────────────────────────────────────
export async function promptAddPromo(ctx, chatId, telegramId) {
  const role = await ensureCap(ctx, chatId, telegramId, 'catalog');
  if (!role) return;
  ctx.sessions.set(chatId, { flow: 'admin', step: 'awaiting_add_promo' });
  await ctx.bot.sendMessage(
    chatId,
    'Create a promo as `CODE | discount | maxUses?`\n' +
      '`SAVE10 | 10% | 100`  or  `FIVEOFF | $5`',
    { parse_mode: 'Markdown' }
  );
}

export async function doAddPromo(ctx, chatId, text) {
  ctx.sessions.delete(chatId);
  const [code, disc, maxUses] = String(text).split('|').map((s) => s.trim());
  if (!code || !disc) {
    await ctx.bot.sendMessage(chatId, 'Format: `CODE | 10% | 100` or `CODE | $5`', { parse_mode: 'Markdown' });
    return;
  }
  const fields = { code, maxUses: maxUses ? Number.parseInt(maxUses, 10) || null : null };
  if (disc.includes('%')) {
    fields.percentOff = Number.parseInt(disc.replace(/[^0-9]/g, ''), 10);
  } else {
    fields.amountOffCents = Math.round(Number.parseFloat(disc.replace(/[^0-9.]/g, '')) * 100);
  }
  if (!fields.percentOff && !fields.amountOffCents) {
    await ctx.bot.sendMessage(chatId, 'Couldn’t parse the discount. Try `10%` or `$5`.', { parse_mode: 'Markdown' });
    return;
  }
  try {
    const p = await createPromo(fields);
    const amt = p.percent_off ? `${p.percent_off}% off` : `${usd(p.amount_off_cents)} off`;
    await ctx.bot.sendMessage(chatId, `✅ Promo *${p.code}* (${amt})${p.max_uses ? `, max ${p.max_uses} uses` : ''}.`, {
      parse_mode: 'Markdown',
    });
  } catch (err) {
    await ctx.bot.sendMessage(chatId, `Couldn’t create it: ${err.message}`);
  }
}

// ── Inventory ────────────────────────────────────────────────────────
export async function showInventory(ctx, chatId, telegramId) {
  const role = await ensureCap(ctx, chatId, telegramId, 'catalog');
  if (!role) return;
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
  const role = await ensureCap(ctx, chatId, telegramId, 'catalog');
  if (!role) return;
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
  const role = await ensureCap(ctx, chatId, telegramId, 'manage_experts');
  if (!role) return;
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

// ── Block Expert management (Block Manager+) ─────────────────────────
// Edit any Block Expert: rate, base address, weekly schedule, active flag.
import { presetWindows } from './expert.js';
import { listExperts as listExpertsDb } from '../supabase.js';

export async function showExperts(ctx, chatId, telegramId) {
  const role = await ensureCap(ctx, chatId, telegramId, 'manage_experts');
  if (!role) return;
  const experts = await listExpertsDb({ activeOnly: false });
  if (!experts.length) {
    await ctx.bot.sendMessage(chatId, 'No Block Experts yet.');
    return;
  }
  const rows = experts.map((e) => [
    {
      text: `${e.active ? '🟢' : '🔴'} ${e.full_name || e.username || e.telegram_id}`,
      callback_data: `adm:exp:${e.id}`,
    },
  ]);
  rows.push([{ text: '⬅️ Back to panel', callback_data: 'adm:menu' }]);
  await ctx.bot.sendMessage(chatId, '🛠️ *Block Experts* — tap one to manage:', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows },
  });
}

export async function showExpertCard(ctx, chatId, telegramId, expertId) {
  const role = await ensureCap(ctx, chatId, telegramId, 'manage_experts');
  if (!role) return;
  const e = await getUserById(expertId);
  if (!e) {
    await ctx.bot.sendMessage(chatId, 'Block Expert not found.');
    return;
  }
  const windows = await getExpertAvailability(e.id);
  await ctx.bot.sendMessage(
    chatId,
    `👷 *${e.full_name || e.username || e.telegram_id}*${e.username ? ` (@${e.username})` : ''}\n` +
      `• Status: ${e.active ? '🟢 active' : '🔴 inactive'}\n` +
      `• 💲 Rate: ${e.rate_cents != null ? usd(e.rate_cents) : 'default'}\n` +
      `• 📍 Base: ${e.address || '— not set —'}\n` +
      `• 🗓️ Availability: ${windows.length ? `${windows.length} weekly block(s)` : 'none set (offered every job)'}`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '💲 Set rate', callback_data: `adm:exprate:${e.id}` },
            { text: '📍 Set base address', callback_data: `adm:expaddr:${e.id}` },
          ],
          [{ text: '🗓️ Set schedule', callback_data: `adm:expsched:${e.id}` }],
          [{ text: e.active ? '🔴 Deactivate' : '🟢 Activate', callback_data: `adm:exptoggle:${e.id}` }],
          [{ text: '⬅️ All Block Experts', callback_data: 'adm:experts' }],
        ],
      },
    }
  );
}

export async function promptExpertRate(ctx, chatId, telegramId, expertId) {
  const role = await ensureCap(ctx, chatId, telegramId, 'manage_experts');
  if (!role) return;
  ctx.sessions.set(chatId, { flow: 'admin', step: 'awaiting_exp_rate', data: { expertId } });
  await ctx.bot.sendMessage(chatId, 'Enter the new per-session rate in dollars (e.g. 45):');
}

export async function doExpertRate(ctx, chatId, text) {
  const s = ctx.sessions.get(chatId);
  const expertId = s?.data?.expertId;
  ctx.sessions.delete(chatId);
  if (!expertId) return;
  const dollars = Number.parseFloat(String(text).replace(/[^0-9.]/g, ''));
  if (Number.isNaN(dollars) || dollars <= 0) {
    await ctx.bot.sendMessage(chatId, 'Please send a valid dollar amount.');
    return;
  }
  const e = await getUserById(expertId);
  if (!e) return;
  await setUserRate(e.telegram_id, Math.round(dollars * 100));
  await ctx.bot.sendMessage(chatId, `✅ Rate set to ${usd(Math.round(dollars * 100))} for ${e.full_name || 'expert'}.`);
}

export async function promptExpertAddress(ctx, chatId, telegramId, expertId) {
  const role = await ensureCap(ctx, chatId, telegramId, 'manage_experts');
  if (!role) return;
  ctx.sessions.set(chatId, { flow: 'admin', step: 'awaiting_exp_addr', data: { expertId } });
  await ctx.bot.sendMessage(chatId, 'Send the new base/pickup address:');
}

export async function doExpertAddress(ctx, chatId, text) {
  const s = ctx.sessions.get(chatId);
  const expertId = s?.data?.expertId;
  ctx.sessions.delete(chatId);
  if (!expertId) return;
  const e = await getUserById(expertId);
  if (!e) return;
  await setUserAddress(e.telegram_id, String(text).trim());
  await ctx.bot.sendMessage(chatId, `✅ Base address updated for ${e.full_name || 'expert'}.`);
}

export async function promptExpertSchedule(ctx, chatId, telegramId, expertId) {
  const role = await ensureCap(ctx, chatId, telegramId, 'manage_experts');
  if (!role) return;
  await ctx.bot.sendMessage(chatId, 'Set their weekly hours (Pacific):', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '⚡ Weekdays 9–5', callback_data: `adm:expav:${expertId}:weekdays` }],
        [{ text: '⚡ Every day 9–9', callback_data: `adm:expav:${expertId}:everyday` }],
        [{ text: '⚡ Weekends 9–9', callback_data: `adm:expav:${expertId}:weekends` }],
        [{ text: '🧹 Clear (offered every job)', callback_data: `adm:expav:${expertId}:clear` }],
        [{ text: '⬅️ Back', callback_data: `adm:exp:${expertId}` }],
      ],
    },
  });
}

export async function setExpertSchedule(ctx, chatId, telegramId, expertId, preset) {
  const role = await ensureCap(ctx, chatId, telegramId, 'manage_experts');
  if (!role) return;
  const windows = presetWindows(preset);
  if (windows === null) return;
  await setExpertAvailability(expertId, windows);
  const e = await getUserById(expertId);
  await ctx.bot.sendMessage(chatId, `✅ Schedule updated (${preset}) for ${e?.full_name || 'expert'}.`);
  try {
    if (e) await ctx.bot.sendMessage(e.telegram_id, '🗓️ A manager updated your weekly availability — check /builder → Availability.');
  } catch {
    /* expert hasn't opened the bot */
  }
}

export async function toggleExpertActive(ctx, chatId, telegramId, expertId) {
  const role = await ensureCap(ctx, chatId, telegramId, 'manage_experts');
  if (!role) return;
  const e = await getUserById(expertId);
  if (!e) return;
  const updated = await setActive(e.telegram_id, !e.active);
  await ctx.bot.sendMessage(chatId, `✅ ${updated.full_name || 'Expert'} is now ${updated.active ? '🟢 active' : '🔴 inactive'}.`);
  await showExpertCard(ctx, chatId, telegramId, expertId);
}

// ── Role management (Administrator+; Administrators are owner-only) ──
export async function showRoles(ctx, chatId, telegramId) {
  const role = await ensureCap(ctx, chatId, telegramId, 'manage_roles');
  if (!role) return;
  const users = await listUsers();
  const staff = users.filter((u) => isStaff(effectiveRole(u)) || u.role === 'expert');
  const lines = staff.length
    ? staff.map((u) => `• ${u.full_name || u.username || u.telegram_id} — *${ROLE_LABELS[u.role] || u.role}*${u.active ? '' : ' (inactive)'}`)
    : ['_No staff or Block Experts yet._'];
  ctx.sessions.set(chatId, { flow: 'admin', step: 'awaiting_role_user' });
  await ctx.bot.sendMessage(
    chatId,
    `🎖️ *Roles*\n\n${lines.join('\n')}\n\nSend a *@handle* or *Telegram ID* to change someone’s role (or /start to cancel):`,
    { parse_mode: 'Markdown' }
  );
}

export async function doPickRoleUser(ctx, chatId, telegramId, text) {
  ctx.sessions.delete(chatId);
  const actorRole = await resolveRole(telegramId);
  if (!can(actorRole, 'manage_roles')) return;
  const key = String(text).trim().replace(/^@/, '').toLowerCase();
  const users = await listUsers();
  const target = users.find(
    (u) => String(u.telegram_id) === key || (u.username || '').toLowerCase() === key
  );
  if (!target) {
    await ctx.bot.sendMessage(chatId, 'No user found with that handle/ID. They must have opened the bot once.');
    return;
  }
  if (!canChangeRoleOf(actorRole, effectiveRole(target))) {
    await ctx.bot.sendMessage(chatId, '🔒 Only the Owner can change an Administrator’s role.');
    return;
  }
  const options = assignableRoles(actorRole).map((r) => [
    { text: ROLE_LABELS[r], callback_data: `adm:setrole:${target.telegram_id}:${r}` },
  ]);
  await ctx.bot.sendMessage(
    chatId,
    `Set role for *${target.full_name || target.username || target.telegram_id}* (currently ${ROLE_LABELS[target.role] || target.role}):`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: options } }
  );
}

export async function doSetRole(ctx, chatId, telegramId, targetTelegramId, newRole) {
  const actorRole = await resolveRole(telegramId);
  if (!can(actorRole, 'manage_roles')) return;
  if (!assignableRoles(actorRole).includes(newRole)) {
    await ctx.bot.sendMessage(chatId, '🔒 You can’t assign that role.');
    return;
  }
  const target = await getUserByTelegramId(Number(targetTelegramId));
  if (!target) return;
  if (!canChangeRoleOf(actorRole, effectiveRole(target))) {
    await ctx.bot.sendMessage(chatId, '🔒 Only the Owner can change an Administrator’s role.');
    return;
  }
  const updated = await setRole(target.telegram_id, newRole);
  await ctx.bot.sendMessage(chatId, `✅ ${updated.full_name || updated.username || updated.telegram_id} is now *${ROLE_LABELS[newRole]}*.`, { parse_mode: 'Markdown' });
  const notes = {
    administrator: '🎖️ You’ve been made an *Administrator* — open /owner for the staff panel.',
    block_manager: '🎖️ You’ve been made a *Block Manager* — open /owner to manage Block Experts.',
    store_manager: '🎖️ You’ve been made a *Store Manager* — open /owner to manage store orders.',
    expert: '🎖️ You’re now a *Block Expert* — tap /builder to set up your portal.',
    customer: 'Your staff access has been removed.',
  };
  try {
    await ctx.bot.sendMessage(target.telegram_id, notes[newRole] || 'Your role was updated.', { parse_mode: 'Markdown' });
  } catch {
    /* target hasn't opened the bot */
  }
}
