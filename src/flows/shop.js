import { config } from '../config.js';
import { priceForQty } from '../lib/pricing.js';
import { qtyKeyboard } from '../lib/keyboards.js';
import { usd } from '../lib/format.js';
import { presentOrderMethods } from './payments.js';

export { priceForQty };

export async function startShop(ctx, chatId) {
  const { unitCents, bundleQty, bundleCents } = config.pricing;
  await ctx.bot.sendMessage(
    chatId,
    `🧱 *Red bricks*\n\n` +
      `• ${usd(unitCents)} each\n` +
      `• ${bundleQty} for ${usd(bundleCents)}\n\n` +
      `How many would you like?`,
    { parse_mode: 'Markdown', ...qtyKeyboard() }
  );
}

export async function promptCustomQty(ctx, chatId) {
  ctx.sessions.set(chatId, { flow: 'shop', step: 'awaiting_qty' });
  await ctx.bot.sendMessage(chatId, 'How many red bricks? Send a number.');
}

// Entry point from qty buttons / custom-qty text → choose a payment method.
export async function checkout(ctx, chatId, _telegramId, qty) {
  await presentOrderMethods(ctx, chatId, qty);
}
