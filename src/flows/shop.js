import { config } from '../config.js';
import { createOrder, attachOrderSession } from '../supabase.js';
import { createOrderCheckout } from '../stripe.js';
import { qtyKeyboard } from '../lib/keyboards.js';
import { usd } from '../lib/format.js';

// Bundle math: every group of `bundleQty` gets the bundle price; the remainder
// is charged at the unit price. e.g. 7 = 1 bundle ($45) + 1 unit ($10).
export function priceForQty(qty) {
  const { unitCents, bundleQty, bundleCents } = config.pricing;
  const bundles = Math.floor(qty / bundleQty);
  const rest = qty % bundleQty;
  return bundles * bundleCents + rest * unitCents;
}

export async function startShop(ctx, chatId) {
  const { unitCents, bundleQty, bundleCents } = config.pricing;
  await ctx.bot.sendMessage(
    chatId,
    `🧱 *Red LEGOs*\n\n` +
      `• ${usd(unitCents)} each\n` +
      `• ${bundleQty} for ${usd(bundleCents)}\n\n` +
      `How many would you like?`,
    { parse_mode: 'Markdown', ...qtyKeyboard() }
  );
}

export async function promptCustomQty(ctx, chatId) {
  ctx.sessions.set(chatId, { flow: 'shop', step: 'awaiting_qty' });
  await ctx.bot.sendMessage(chatId, 'How many red LEGOs? Send a number.');
}

export async function checkout(ctx, chatId, telegramId, qty) {
  if (!Number.isInteger(qty) || qty <= 0) {
    await ctx.bot.sendMessage(chatId, 'Please send a whole number greater than 0.');
    return;
  }
  ctx.sessions.delete(chatId);
  if (!config.stripe.enabled) {
    await ctx.bot.sendMessage(chatId, '🛒 Online payments aren’t live yet — please check back soon!');
    return;
  }
  const amountCents = priceForQty(qty);
  const order = await createOrder({ telegramId, qty, amountCents });
  const session = await createOrderCheckout({ order, telegramId });
  await attachOrderSession(order.id, session.id);

  await ctx.bot.sendMessage(
    chatId,
    `🧾 *${qty} × red LEGO* — total *${usd(amountCents)}*\n\nTap to pay securely via Stripe:`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: `Pay ${usd(amountCents)}`, url: session.url }]],
      },
    }
  );
}
