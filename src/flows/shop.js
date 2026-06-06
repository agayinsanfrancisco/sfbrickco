import { config } from '../config.js';
import { listProducts, getProduct, createOrder, lastDeliveryAddress } from '../supabase.js';
import { priceForProduct, packOptions } from '../lib/pricing.js';
import { estimateSurcharge } from '../uber.js';
import { qtyKeyboard } from '../lib/keyboards.js';
import { usd, shortRef } from '../lib/format.js';
import { presentOrderMethods } from './payments.js';

export async function startShop(ctx, chatId) {
  const products = await listProducts();
  if (!products.length) {
    await ctx.bot.sendMessage(chatId, '🧱 The shop is being restocked — check back soon!');
    return;
  }
  const rows = products.map((p) => [{ text: p.name, callback_data: `shop:p:${p.sku}` }]);
  await ctx.bot.sendMessage(chatId, '🧱 *Shop* — pick a product:', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows },
  });
}

export async function chooseProduct(ctx, chatId, sku) {
  const p = await getProduct(sku);
  if (!p || !p.active) {
    await ctx.bot.sendMessage(chatId, 'That product isn’t available.');
    return;
  }
  if (p.price_mode === 'packs') {
    const rows = packOptions(p).map((pk) => [
      { text: `${pk.qty} for ${usd(pk.cents)}`, callback_data: `shop:pack:${sku}:${pk.qty}` },
    ]);
    await ctx.bot.sendMessage(chatId, `*${p.name}*\nChoose a pack:`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: rows },
    });
  } else {
    ctx.sessions.set(chatId, { flow: 'shop', sku });
    await ctx.bot.sendMessage(
      chatId,
      `*${p.name}*\n• ${usd(p.unit_price_cents)} each\n• ${p.bundle_qty} for ${usd(
        p.bundle_price_cents
      )}\n\nHow many?`,
      { parse_mode: 'Markdown', ...qtyKeyboard() }
    );
  }
}

export async function promptCustomQty(ctx, chatId) {
  const s = ctx.sessions.get(chatId) || {};
  ctx.sessions.set(chatId, { ...s, flow: 'shop', step: 'awaiting_qty' });
  await ctx.bot.sendMessage(chatId, 'How many? Send a number.');
}

// unit_bundle quantity chosen (button or typed)
export async function chooseQty(ctx, chatId, qty) {
  const s = ctx.sessions.get(chatId);
  if (!s?.sku) {
    await ctx.bot.sendMessage(chatId, 'Let’s start over — tap /shop.');
    return;
  }
  if (!Number.isInteger(qty) || qty <= 0) {
    await ctx.bot.sendMessage(chatId, 'Please send a whole number greater than 0.');
    return;
  }
  await beginDelivery(ctx, chatId, s.sku, qty);
}

export async function choosePack(ctx, chatId, sku, qty) {
  await beginDelivery(ctx, chatId, sku, qty);
}

async function beginDelivery(ctx, chatId, sku, qty) {
  const p = await getProduct(sku);
  if (!p) {
    await ctx.bot.sendMessage(chatId, 'Product not found.');
    return;
  }
  if ((p.stock_qty ?? 0) < qty) {
    await ctx.bot.sendMessage(
      chatId,
      (p.stock_qty ?? 0) === 0
        ? `😔 ${p.name} is sold out right now.`
        : `Only ${p.stock_qty} ${p.name} in stock. Try a smaller quantity.`
    );
    return;
  }
  if (priceForProduct(p, qty) == null) {
    await ctx.bot.sendMessage(chatId, 'That quantity isn’t available for this product.');
    return;
  }
  // Offer the customer's last delivery address (#42). In private chat
  // chatId === telegramId, so it doubles as the user key for the lookup.
  const last = await lastDeliveryAddress(chatId);
  ctx.sessions.set(chatId, { flow: 'shop', step: 'awaiting_delivery_address', sku, qty, lastAddr: last });
  // With a saved address, offer the one-tap button; otherwise force_reply with a
  // format placeholder so the input box guides street / city / ZIP.
  const reply_markup = last
    ? { inline_keyboard: [[{ text: `📍 Use last: ${last.slice(0, 40)}`, callback_data: 'shop:lastaddr' }]] }
    : { force_reply: true, input_field_placeholder: '123 Main St, San Francisco, CA 94110' };
  await ctx.bot.sendMessage(
    chatId,
    `📍 What’s the *delivery address*? (Street, city, ZIP)\n` +
      `We courier your ${p.name} by Uber and add the delivery fee at checkout.`,
    { parse_mode: 'Markdown', reply_markup }
  );
}

export async function useLastAddress(ctx, chatId) {
  const s = ctx.sessions.get(chatId);
  if (!s?.lastAddr) {
    await ctx.bot.sendMessage(chatId, 'Please type your delivery address.');
    return;
  }
  await receiveDeliveryAddress(ctx, chatId, chatId, s.lastAddr);
}

export async function receiveDeliveryAddress(ctx, chatId, _telegramId, address) {
  const s = ctx.sessions.get(chatId);
  if (!s?.sku) return;
  const est = await estimateSurcharge(address);
  const deliveryFee = est.ok ? est.surchargeCents : config.uber.flatFallbackCents;
  ctx.sessions.set(chatId, { ...s, step: 'awaiting_phone', address, deliveryFee });
  await ctx.bot.sendMessage(
    chatId,
    '📱 Share your phone number so the courier can reach you (or just type it):',
    {
      reply_markup: {
        keyboard: [[{ text: '📱 Share my number', request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    }
  );
}

export async function receivePhone(ctx, chatId, telegramId, phone, handle) {
  const s = ctx.sessions.get(chatId);
  if (!s?.sku || s.step !== 'awaiting_phone') return;
  ctx.sessions.set(chatId, { ...s, step: 'awaiting_note', phone: phone || null, handle: handle || null });
  await ctx.bot.sendMessage(
    chatId,
    '📝 Any delivery notes (gate code, unit #, drop-off spot)? Type a message, or tap Skip.',
    { reply_markup: { inline_keyboard: [[{ text: 'Skip', callback_data: 'shop:noteskip' }]] } }
  );
}

async function finalizeOrder(ctx, chatId, telegramId, note) {
  const s = ctx.sessions.get(chatId);
  if (!s?.sku || s.step !== 'awaiting_note') return;
  ctx.sessions.delete(chatId);
  const p = await getProduct(s.sku);
  const itemCents = priceForProduct(p, s.qty);
  const order = await createOrder({
    telegramId,
    sku: s.sku,
    qty: s.qty,
    amountCents: itemCents,
    deliveryFeeCents: s.deliveryFee,
    deliveryAddress: s.address,
    contactPhone: s.phone,
    contactHandle: s.handle,
    notes: note,
  });
  await ctx.bot.sendMessage(chatId, `✅ Order *${shortRef(order.id)}* created — thanks!`, {
    parse_mode: 'Markdown',
    reply_markup: { remove_keyboard: true },
  });
  await presentOrderMethods(ctx, chatId, order, p);
}

export async function receiveNote(ctx, chatId, telegramId, text) {
  await finalizeOrder(ctx, chatId, telegramId, text);
}

export async function skipNote(ctx, chatId, telegramId) {
  await finalizeOrder(ctx, chatId, telegramId, null);
}
