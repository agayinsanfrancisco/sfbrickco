import { config } from '../config.js';
import * as crypto from '../crypto.js';
import { usd } from '../lib/format.js';
import { getBalance, listLedger, createDeposit, nextDerivationIndex } from '../supabase.js';

// USD store credit (spend-only). Deposits reuse the order crypto rails: a
// unique derived address per top-up, auto-credited by the watcher. Requires an
// xpub for the coin (no per-deposit address without it).
const PRESETS = [2500, 5000, 10000]; // $25 / $50 / $100
const MIN_CENTS = 500;

export async function showWallet(ctx, chatId, telegramId) {
  const balance = await getBalance(telegramId);
  await ctx.bot.sendMessage(
    chatId,
    `💰 *Your wallet*\n\nBalance: *${usd(balance)}*\n\n` +
      'Top up with crypto, then pay for orders & bookings instantly from your balance.',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '➕ Add funds', callback_data: 'wal:add' }],
          [{ text: '🧾 Statement', callback_data: 'wal:stmt' }],
        ],
      },
    }
  );
}

export async function startDeposit(ctx, chatId) {
  const rows = PRESETS.map((c) => [{ text: `Add ${usd(c)}`, callback_data: `wal:amt:${c}` }]);
  rows.push([{ text: 'Other amount…', callback_data: 'wal:amt:custom' }]);
  await ctx.bot.sendMessage(chatId, 'How much would you like to add?', {
    reply_markup: { inline_keyboard: rows },
  });
}

export async function promptCustomAmount(ctx, chatId) {
  ctx.sessions.set(chatId, { flow: 'wallet', step: 'awaiting_amount' });
  await ctx.bot.sendMessage(chatId, 'Enter an amount in USD (e.g. 40):');
}

export async function receiveCustomAmount(ctx, chatId, text) {
  const dollars = Number.parseFloat(String(text).replace(/[^0-9.]/g, ''));
  if (Number.isNaN(dollars) || dollars <= 0) {
    await ctx.bot.sendMessage(chatId, 'Please enter a valid dollar amount.');
    return;
  }
  ctx.sessions.delete(chatId);
  await chooseAmount(ctx, chatId, Math.round(dollars * 100));
}

export async function chooseAmount(ctx, chatId, cents) {
  if (!Number.isInteger(cents) || cents < MIN_CENTS) {
    await ctx.bot.sendMessage(chatId, `Minimum top-up is ${usd(MIN_CENTS)}. Try again.`);
    return;
  }
  const rows = [];
  if (crypto.hasXpub('btc')) rows.push([{ text: '₿ Bitcoin', callback_data: `wal:coin:btc:${cents}` }]);
  if (crypto.hasXpub('ltc')) rows.push([{ text: 'Ł Litecoin', callback_data: `wal:coin:ltc:${cents}` }]);
  if (!rows.length) {
    await ctx.bot.sendMessage(chatId, 'Automatic top-ups aren’t available right now.');
    return;
  }
  await ctx.bot.sendMessage(chatId, `Add *${usd(cents)}* — pick a coin:`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows },
  });
}

export async function payDeposit(ctx, chatId, telegramId, coin, cents) {
  if (!crypto.hasXpub(coin)) {
    await ctx.bot.sendMessage(chatId, 'Automatic top-ups aren’t available for that coin yet.');
    return;
  }
  ctx.sessions.delete(chatId);
  let amount, rate;
  try {
    ({ amount, rate } = await crypto.quoteWithRate(coin, cents));
  } catch {
    await ctx.bot.sendMessage(chatId, '⚠️ Couldn’t fetch the exchange rate. Try again shortly.');
    return;
  }
  const index = await nextDerivationIndex(coin);
  const address = crypto.receiveAddress(coin, index);
  const payExpiresAt = new Date(Date.now() + config.crypto.quoteTtlMs).toISOString();
  await createDeposit({
    telegramId,
    payCoin: coin,
    payAddress: address,
    payIndex: index,
    cryptoAmount: amount,
    usdCents: cents,
    payExpiresAt,
    usdRate: rate,
  });
  const c = crypto.COINS[coin];
  const caption =
    `Send *${amount} ${c.ticker}* (≈ ${usd(cents)}) to top up your wallet:\n\n` +
    `\`${address}\`\n\n` +
    'We’ll credit your balance automatically once it’s on-chain (usually a few minutes). ' +
    'Whatever you send is credited at the current rate.';
  try {
    const png = await crypto.qrPng(coin, amount, address);
    await ctx.bot.sendPhoto(chatId, png, { caption, parse_mode: 'Markdown' });
  } catch {
    await ctx.bot.sendMessage(chatId, caption, { parse_mode: 'Markdown' });
  }
}

export async function showStatement(ctx, chatId, telegramId) {
  const [balance, rows] = await Promise.all([getBalance(telegramId), listLedger(telegramId, 10)]);
  if (!rows.length) {
    await ctx.bot.sendMessage(chatId, `Balance: *${usd(balance)}*\n\nNo transactions yet.`, {
      parse_mode: 'Markdown',
    });
    return;
  }
  const lines = rows.map((r) => {
    const sign = r.delta_cents >= 0 ? '+' : '−';
    return `${sign}${usd(Math.abs(r.delta_cents))} · ${r.kind} → ${usd(r.balance_after)}`;
  });
  await ctx.bot.sendMessage(chatId, `🧾 *Statement* (balance ${usd(balance)})\n\n${lines.join('\n')}`, {
    parse_mode: 'Markdown',
  });
}
