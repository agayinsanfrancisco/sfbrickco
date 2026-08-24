import { config } from './config.js';
import * as crypto from './crypto.js';
import {
  listWatchableOrders,
  listWatchableBookings,
  listWatchableDeposits,
  recordOrderTx,
  recordBookingTx,
  markDepositCredited,
  expireDeposit,
  creditBalance,
  hasReceivedBonus,
  hasQualifyingBrickPurchase,
} from './supabase.js';
import { confirmOrder, confirmBooking } from './flows/payments.js';
import { getIntSetting } from './lib/settings.js';
import { usd } from './lib/format.js';

// Poll public explorers for payments to each item's derived address and
// auto-confirm once the confirmed received amount meets the quote (within a
// small slippage tolerance). Only looks at recent, still-unpaid items so the
// query (and explorer calls) stay small.
const WINDOW_MS = 24 * 60 * 60 * 1000;

// Addresses we've already alerted admins about for underpayment, so we don't
// re-alert every tick. In-memory: resets on restart (acceptable for an alert).
const underpaidAlerted = new Set();
// Items we've already told the customer "payment detected, confirming…" about,
// so the mempool acknowledgement fires once, not every 60s tick.
const mempoolAcked = new Set();

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
  // Tell the customer too, with the exact shortfall and the SAME address —
  // most underpayments are fee-rounding and a small top-up completes the order.
  const customerId = kind === 'order' ? item.telegram_id : item.customer_telegram_id;
  const shortfallSats = Math.max(0, crypto.toSats(item.crypto_amount) - confirmedSats);
  if (customerId && shortfallSats > 0) {
    try {
      await ctx.bot.sendMessage(
        customerId,
        `⚠️ *Your payment arrived a little short.*\n` +
          `We received ${(confirmedSats / 1e8).toFixed(8)} ${c.ticker} but need ${item.crypto_amount} ${c.ticker}.\n\n` +
          `Send the difference — *${(shortfallSats / 1e8).toFixed(8)} ${c.ticker}* — to the same address:\n` +
          `\`${item.pay_address}\`\n\nWe’ll confirm automatically as soon as it lands.`,
        { parse_mode: 'Markdown' }
      );
    } catch {
      /* customer hasn't opened the bot */
    }
  }
}

async function settle(ctx, kind, item, confirm, recordTx) {
  if (!item.pay_coin || !item.pay_address || !item.crypto_amount) return;
  let confirmedSats, mempoolSats;
  try {
    ({ confirmed: confirmedSats, mempool: mempoolSats } = await crypto.getConfirmedReceived(item.pay_coin, item.pay_address));
  } catch (err) {
    // Explorer hiccup / timeout — log and retry next tick (don't block others).
    console.error(`watch ${kind} ${item.id} (${item.pay_coin}):`, err.message);
    return;
  }
  const key = `${kind}:${item.id}`;
  if (confirmedSats <= 0) {
    // Seen in the mempool but not yet in a block — tell the customer we've got
    // it and are waiting on confirmation, so they don't sit in silence.
    if ((mempoolSats || 0) > 0 && !mempoolAcked.has(key)) {
      mempoolAcked.add(key);
      const customerId = kind === 'order' ? item.telegram_id : item.customer_telegram_id;
      try {
        await ctx.bot.sendMessage(
          customerId,
          '⏳ *Payment detected!* We can see your transaction on the network and are waiting for it to confirm (usually one block — a few minutes for LTC, up to ~30–60 min for BTC). We’ll message you the moment it clears — no need to send anything else.',
          { parse_mode: 'Markdown' }
        );
      } catch {
        /* customer hasn't opened the bot */
      }
    }
    return;
  }
  if (!meetsThreshold(confirmedSats, item.crypto_amount)) {
    await alertUnderpaid(ctx, kind, item, confirmedSats);
    return;
  }
  const ok = await confirm(ctx, item, { auto: true });
  if (ok) {
    const tx = await crypto.getFundingTx(item.pay_coin, item.pay_address);
    if (tx) await recordTx(item.id, tx);
    underpaidAlerted.delete(key);
    mempoolAcked.delete(key);
    // Overpayment → credit the excess to the customer's wallet (not silently
    // kept). Only when the surplus is worth more than a cent.
    try {
      const requiredSats = crypto.toSats(item.crypto_amount);
      const surplusSats = confirmedSats - requiredSats;
      if (surplusSats > 0) {
        const surplus = (surplusSats / 1e8).toFixed(8);
        const surplusCents = await crypto.valueUsdCents(item.pay_coin, surplus);
        if (surplusCents >= 1) {
          const customerId = kind === 'order' ? item.telegram_id : item.customer_telegram_id;
          const balance = await creditBalance(customerId, surplusCents, {
            kind: 'adjustment',
            refType: kind,
            refId: item.id,
          });
          try {
            await ctx.bot.sendMessage(
              customerId,
              `💰 You sent a little extra — we credited *${usd(surplusCents)}* to your wallet. Balance: *${usd(balance)}*.`,
              { parse_mode: 'Markdown' }
            );
          } catch {
            /* ignore */
          }
        }
      }
    } catch (err) {
      console.error(`overpay credit ${key}:`, err.message);
    }
  }
}

// Wallet top-ups: credit whatever value actually arrives (no exact-amount
// match needed), then DM the customer. Idempotent via markDepositCredited.
async function settleDeposit(ctx, dep) {
  if (!dep.pay_coin || !dep.pay_address) return;
  let confirmedSats;
  try {
    ({ confirmed: confirmedSats } = await crypto.getConfirmedReceived(dep.pay_coin, dep.pay_address));
  } catch (err) {
    console.error(`watch deposit ${dep.id} (${dep.pay_coin}):`, err.message);
    return;
  }
  if (confirmedSats <= 0) {
    // Drop stale, never-funded deposits out of the watch set.
    if (dep.pay_expires_at && Date.parse(dep.pay_expires_at) <= Date.now()) await expireDeposit(dep.id);
    return;
  }
  const received = (confirmedSats / 1e8).toFixed(8);
  let credited;
  try {
    credited = await crypto.valueUsdCents(dep.pay_coin, received);
  } catch (err) {
    console.error(`deposit value ${dep.id}:`, err.message);
    return;
  }
  const tx = await crypto.getFundingTx(dep.pay_coin, dep.pay_address);
  const marked = await markDepositCredited(dep.id, {
    creditedCents: credited,
    txid: tx?.txid ?? null,
    blockHeight: tx?.blockHeight ?? null,
  });
  if (!marked) return; // already credited (idempotent)
  let balance = await creditBalance(dep.telegram_id, credited, {
    kind: 'deposit',
    refType: 'deposit',
    refId: dep.id,
  });
  try {
    await ctx.bot.sendMessage(
      dep.telegram_id,
      `💰 Deposit received — *${usd(credited)}* added. Balance: *${usd(balance)}*.`,
      { parse_mode: 'Markdown' }
    );
  } catch {
    /* customer hasn't opened the bot */
  }

  // Deposit bonus: unlocked by a prior qualifying brick purchase (the 6-pack
  // gate), paid as a % of THIS deposit, capped, and only on the customer's
  // FIRST deposit (once per customer via the bonus-ledger guard).
  try {
    const pct = await getIntSetting('deposit_bonus_pct', 0);
    const capCents = await getIntSetting('deposit_bonus_cap_cents', 0);
    const qualifyingQty = await getIntSetting('bonus_qualifying_qty', 6);
    if (
      pct > 0 &&
      !(await hasReceivedBonus(dep.telegram_id)) &&
      (await hasQualifyingBrickPurchase(dep.telegram_id, qualifyingQty))
    ) {
      let bonus = Math.round((credited * pct) / 100);
      if (capCents > 0) bonus = Math.min(bonus, capCents);
      if (bonus > 0) {
        balance = await creditBalance(dep.telegram_id, bonus, {
          kind: 'bonus',
          refType: 'deposit',
          refId: dep.id,
        });
        await ctx.bot.sendMessage(
          dep.telegram_id,
          `🎁 First-deposit bonus — *${usd(bonus)}* added (${pct}% of your deposit${
            capCents > 0 ? `, up to ${usd(capCents)}` : ''
          }). Balance: *${usd(balance)}*.`,
          { parse_mode: 'Markdown' }
        );
      }
    }
  } catch {
    /* bonus is best-effort; never block a credited deposit */
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
  for (const d of await listWatchableDeposits(since)) {
    await settleDeposit(ctx, d);
  }
}
