import { config } from './config.js';
import * as crypto from './crypto.js';
import {
  listWatchableOrders,
  listWatchableBookings,
  recordOrderTx,
  recordBookingTx,
} from './supabase.js';
import { confirmOrder, confirmBooking } from './flows/payments.js';

// Poll public explorers for payments to each item's derived address and
// auto-confirm once the confirmed received amount meets the quote (within a
// small slippage tolerance). Only looks at recent, still-unpaid items so the
// query (and explorer calls) stay small.
const WINDOW_MS = 24 * 60 * 60 * 1000;

// Addresses we've already alerted admins about for underpayment, so we don't
// re-alert every tick. In-memory: resets on restart (acceptable for an alert).
const underpaidAlerted = new Set();

function meetsThreshold(confirmedSats, cryptoAmount) {
  return confirmedSats >= crypto.toSats(cryptoAmount) * config.crypto.fundedTolerance;
}

async function alertUnderpaid(ctx, kind, item, confirmedSats) {
  const key = `${kind}:${item.id}`;
  if (underpaidAlerted.has(key)) return;
  underpaidAlerted.add(key);
  const c = crypto.COINS[item.pay_coin];
  const explorer = crypto.explorerUrl(item.pay_coin, item.pay_address);
  const reply_markup = explorer
    ? { inline_keyboard: [[{ text: `🔎 ${c.ticker} explorer`, url: explorer }]] }
    : undefined;
  for (const adminId of config.adminIds) {
    try {
      await ctx.bot.sendMessage(
        adminId,
        `⚠️ *Underpayment* on ${kind} \`${item.id}\`\n` +
          `Received ${(confirmedSats / 1e8).toFixed(8)} ${c.ticker}, expected ${item.crypto_amount}.\n` +
          `Verify on the explorer, then credit, refund, or ask the customer to top up.`,
        { parse_mode: 'Markdown', reply_markup }
      );
    } catch {
      /* admin hasn't opened the bot */
    }
  }
}

async function settle(ctx, kind, item, confirm, recordTx) {
  if (!item.pay_coin || !item.pay_address || !item.crypto_amount) return;
  let confirmedSats;
  try {
    ({ confirmed: confirmedSats } = await crypto.getConfirmedReceived(item.pay_coin, item.pay_address));
  } catch (err) {
    // Explorer hiccup / timeout — log and retry next tick (don't block others).
    console.error(`watch ${kind} ${item.id} (${item.pay_coin}):`, err.message);
    return;
  }
  if (confirmedSats <= 0) return;
  if (!meetsThreshold(confirmedSats, item.crypto_amount)) {
    await alertUnderpaid(ctx, kind, item, confirmedSats);
    return;
  }
  const ok = await confirm(ctx, item, { auto: true });
  if (ok) {
    const tx = await crypto.getFundingTx(item.pay_coin, item.pay_address);
    if (tx) await recordTx(item.id, tx);
    underpaidAlerted.delete(`${kind}:${item.id}`);
  }
}

export async function watchOnce(ctx) {
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  for (const o of await listWatchableOrders(since)) {
    await settle(ctx, 'order', o, confirmOrder, recordOrderTx);
  }
  for (const b of await listWatchableBookings(since)) {
    await settle(ctx, 'booking', b, confirmBooking, recordBookingTx);
  }
}
