import { config } from '../config.js';
import { listProducts, getProduct, createOrder, lastDeliveryAddress, logEvent, setOrderPromo } from '../supabase.js';
import { priceForProduct, packOptions } from '../lib/pricing.js';
import { estimateSurcharge } from '../uber.js';
import { qtyKeyboard } from '../lib/keyboards.js';
import { usd, shortRef } from '../lib/format.js';
import { getBoolSetting, getIntSetting } from '../lib/settings.js';
import { deliveryAfterThreshold, cartSubtotalCents } from '../lib/money.js';
import { presentWaiver } from './payments.js';

// Cart lives in the session as `cart: [{ sku, name, qty, line_cents }]`.
function getCart(ctx, chatId) {
  return ctx.sessions.get(chatId)?.cart || [];
}
function qtyInCart(cart, sku) {
  return cart.filter((i) => i.sku === sku).reduce((s, i) => s + i.qty, 0);
}

// Entry from the post-booking upsell: start shopping with a standing 20% off
// that auto-applies to the resulting order (#11).
export async function startUpsell(ctx, chatId, percent = 20) {
  ctx.sessions.set(chatId, { flow: 'shop', cart: [], upsellPercent: percent });
  await startShop(ctx, chatId);
}

export async function startShop(ctx, chatId) {
  if (!(await getBoolSetting('flag_shop', true))) {
    await ctx.bot.sendMessage(chatId, '🛒 The shop is closed right now — check back soon!');
    return;
  }
  logEvent(chatId, 'shop_start');
  const products = await listProducts();
  if (!products.length) {
    await ctx.bot.sendMessage(chatId, '🧱 The shop is being restocked — check back soon!');
    return;
  }
  const rows = products.map((p) => [{ text: p.name, callback_data: `shop:p:${p.sku}` }]);
  const cart = getCart(ctx, chatId);
  if (cart.length) rows.push([{ text: `🛒 View cart (${cart.length})`, callback_data: 'shop:cart' }]);
  rows.push([{ text: '🛠️ Hire an Admin', callback_data: 'shop:addadmin' }]);
  const bonus = await getIntSetting('brick_bonus_cents', 0);
  const bonusQty = await getIntSetting('bonus_qualifying_qty', 6);
  const offer = bonus > 0
    ? `\n🎁 New here? Grab a *${bonusQty}-pack* and get *${usd(bonus)}* in wallet credit — buy more, save more!`
    : '';
  await ctx.bot.sendMessage(chatId, `🧱 *Shop* — pick a product:${offer}`, {
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
  const s = ctx.sessions.get(chatId) || {};
  if (p.price_mode === 'packs') {
    const rows = packOptions(p).map((pk) => [
      { text: `${pk.qty} for ${usd(pk.cents)}`, callback_data: `shop:pack:${sku}:${pk.qty}` },
    ]);
    ctx.sessions.set(chatId, { ...s, flow: 'shop', cart: s.cart || [] });
    await ctx.bot.sendMessage(chatId, `*${p.name}*\nChoose a pack:`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: rows },
    });
  } else {
    ctx.sessions.set(chatId, { ...s, flow: 'shop', cart: s.cart || [], sku });
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
  await addToCart(ctx, chatId, s.sku, qty);
}

export async function choosePack(ctx, chatId, sku, qty) {
  await addToCart(ctx, chatId, sku, qty);
}

async function addToCart(ctx, chatId, sku, qty) {
  const p = await getProduct(sku);
  if (!p || !p.active) {
    await ctx.bot.sendMessage(chatId, 'That product isn’t available.');
    return;
  }
  const cart = getCart(ctx, chatId);
  const already = qtyInCart(cart, sku);
  if ((p.stock_qty ?? 0) < already + qty) {
    await ctx.bot.sendMessage(
      chatId,
      (p.stock_qty ?? 0) === 0
        ? `😔 ${p.name} is sold out right now.`
        : `Only ${p.stock_qty} ${p.name} in stock${already ? ` (you already have ${already} in your cart)` : ''}.`
    );
    return;
  }
  const lineCents = priceForProduct(p, qty);
  if (lineCents == null) {
    await ctx.bot.sendMessage(chatId, 'That quantity isn’t available for this product.');
    return;
  }
  cart.push({ sku, name: p.name, qty, line_cents: lineCents });
  const s = ctx.sessions.get(chatId) || {};
  ctx.sessions.set(chatId, { flow: 'shop', cart, sku: undefined, step: undefined, ...keepCheckout(s) });
  await showCart(ctx, chatId);
}

// Preserve any in-progress checkout fields when we rewrite the session.
function keepCheckout(s) {
  const { address, deliveryFee, phone, handle, lastAddr, upsellPercent } = s;
  return { address, deliveryFee, phone, handle, lastAddr, upsellPercent };
}

export async function showCart(ctx, chatId) {
  const cart = getCart(ctx, chatId);
  if (!cart.length) {
    await ctx.bot.sendMessage(chatId, 'Your cart is empty. Tap /shop to add items.');
    return;
  }
  const lines = cart.map((i) => `• ${i.qty}× ${i.name} — ${usd(i.line_cents)}`);
  await ctx.bot.sendMessage(
    chatId,
    `🛒 *Your cart*\n${lines.join('\n')}\n\n*Subtotal: ${usd(cartSubtotalCents(cart))}*`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '➕ Add another', callback_data: 'shop:start' }],
          [{ text: '🛠️ Hire an Admin', callback_data: 'shop:addadmin' }],
          [{ text: '✅ Checkout', callback_data: 'shop:checkout' }],
          [{ text: '🗑️ Clear cart', callback_data: 'shop:clear' }],
        ],
      },
    }
  );
}

export async function clearCart(ctx, chatId) {
  ctx.sessions.delete(chatId);
  await ctx.bot.sendMessage(chatId, '🗑️ Cart cleared.');
}

async function askStreet(ctx, chatId) {
  await ctx.bot.sendMessage(chatId, '📍 What’s your *street address*?', {
    parse_mode: 'Markdown',
    reply_markup: { force_reply: true, input_field_placeholder: '123 Main St' },
  });
}

// Checkout the whole cart → collect delivery address (street → city → ZIP).
export async function checkout(ctx, chatId) {
  const cart = getCart(ctx, chatId);
  if (!cart.length) {
    await ctx.bot.sendMessage(chatId, 'Your cart is empty. Tap /shop to add items.');
    return;
  }
  const last = await lastDeliveryAddress(chatId);
  const s = ctx.sessions.get(chatId) || {};
  ctx.sessions.set(chatId, { ...keepCheckout(s), flow: 'shop', cart, step: 'awaiting_street', lastAddr: last });
  if (last) {
    await ctx.bot.sendMessage(chatId, `📍 Deliver to your last address?\n${last}`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📍 Use this address', callback_data: 'shop:lastaddr' }],
          [{ text: '✏️ Enter a new address', callback_data: 'shop:newaddr' }],
        ],
      },
    });
  } else {
    await askStreet(ctx, chatId);
  }
}

export async function promptNewAddress(ctx, chatId) {
  const s = ctx.sessions.get(chatId) || {};
  ctx.sessions.set(chatId, { ...s, step: 'awaiting_street' });
  await askStreet(ctx, chatId);
}

export async function useLastAddress(ctx, chatId) {
  const s = ctx.sessions.get(chatId);
  if (!s?.lastAddr) {
    await askStreet(ctx, chatId);
    return;
  }
  await addressComplete(ctx, chatId, s.lastAddr);
}

export async function receiveStreet(ctx, chatId, street) {
  const s = ctx.sessions.get(chatId);
  if (s?.flow !== 'shop' || s.step !== 'awaiting_street') return;
  ctx.sessions.set(chatId, { ...s, step: 'awaiting_city', street });
  await ctx.bot.sendMessage(chatId, 'And the *city*?', {
    parse_mode: 'Markdown',
    reply_markup: { force_reply: true, input_field_placeholder: 'San Francisco' },
  });
}

export async function receiveCity(ctx, chatId, city) {
  const s = ctx.sessions.get(chatId);
  if (s?.flow !== 'shop' || s.step !== 'awaiting_city') return;
  ctx.sessions.set(chatId, { ...s, step: 'awaiting_zip', city });
  await ctx.bot.sendMessage(chatId, 'And your *ZIP code*?', {
    parse_mode: 'Markdown',
    reply_markup: { force_reply: true, input_field_placeholder: '94110' },
  });
}

export async function receiveZip(ctx, chatId, zip) {
  const s = ctx.sessions.get(chatId);
  if (s?.flow !== 'shop' || s.step !== 'awaiting_zip') return;
  const address = `${s.street}, ${s.city}, CA ${zip}`.replace(/\s+/g, ' ').trim();
  await addressComplete(ctx, chatId, address);
}

async function addressComplete(ctx, chatId, address) {
  const s = ctx.sessions.get(chatId);
  if (!s?.cart?.length) return;
  const est = await estimateSurcharge(address);
  if (est.ok && est.tooFar) {
    await ctx.bot.sendMessage(
      chatId,
      `😔 That address is ~${est.miles} mi out — beyond our ${config.uber.maxMiles}-mile delivery area. Tap /shop and try another address.`
    );
    ctx.sessions.delete(chatId);
    return;
  }
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
  if (!s?.cart?.length || s.step !== 'awaiting_phone') return;
  ctx.sessions.set(chatId, { ...s, step: 'awaiting_note', phone: phone || null, handle: handle || null });
  await ctx.bot.sendMessage(
    chatId,
    '📝 Any delivery notes (gate code, unit #, drop-off spot)? Type a message, or tap Skip.',
    { reply_markup: { inline_keyboard: [[{ text: 'Skip', callback_data: 'shop:noteskip' }]] } }
  );
}

async function finalizeOrder(ctx, chatId, telegramId, note) {
  const s = ctx.sessions.get(chatId);
  if (!s?.cart?.length || s.step !== 'awaiting_note') return;
  ctx.sessions.delete(chatId);
  const cart = s.cart;
  const subtotal = cartSubtotalCents(cart);
  const totalQty = cart.reduce((sum, i) => sum + i.qty, 0);
  // Free-delivery threshold (#45): 0 = disabled.
  const threshold = await getIntSetting('free_delivery_threshold_cents', 0);
  const deliveryFee = deliveryAfterThreshold(subtotal, s.deliveryFee, threshold);
  let order = await createOrder({
    telegramId,
    sku: cart.length === 1 ? cart[0].sku : `cart:${cart.length}`,
    qty: totalQty,
    amountCents: subtotal,
    deliveryFeeCents: deliveryFee,
    deliveryAddress: s.address,
    contactPhone: s.phone,
    contactHandle: s.handle,
    notes: note,
    items: cart,
  });
  // Post-booking upsell discount auto-applies to the parts subtotal (#11).
  if (s.upsellPercent) {
    const discount = Math.round((subtotal * s.upsellPercent) / 100);
    const updated = await setOrderPromo(order.id, { code: `BUILD${s.upsellPercent}`, discountCents: discount });
    if (updated) order = updated;
  }
  logEvent(telegramId, 'order_created', { items: cart.length, qty: totalQty, cents: subtotal, upsell: !!s.upsellPercent });
  await ctx.bot.sendMessage(chatId, `✅ Order *${shortRef(order.id)}* created — thanks!`, {
    parse_mode: 'Markdown',
    reply_markup: { remove_keyboard: true },
  });
  await presentWaiver(ctx, chatId, 'o', order.id);
}

export async function receiveNote(ctx, chatId, telegramId, text) {
  await finalizeOrder(ctx, chatId, telegramId, text);
}

export async function skipNote(ctx, chatId, telegramId) {
  await finalizeOrder(ctx, chatId, telegramId, null);
}
