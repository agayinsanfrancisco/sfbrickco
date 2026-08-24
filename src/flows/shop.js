import { config } from '../config.js';
import {
  listProducts,
  getProduct,
  createOrder,
  lastDeliveryAddress,
  logEvent,
  setOrderPromo,
  listBookingsByCustomer,
  linkOrderToBooking,
} from '../supabase.js';
import { priceForProduct, packOptions } from '../lib/pricing.js';
import { estimateSurcharge } from '../uber.js';
import { qtyKeyboard } from '../lib/keyboards.js';
import { usd, shortRef } from '../lib/format.js';
import { getBoolSetting, getIntSetting } from '../lib/settings.js';
import { deliveryAfterThreshold, cartSubtotalCents } from '../lib/money.js';
import { acceptWaiver } from './payments.js';
import { issueTermsToken, hasViewedTerms } from '../lib/termsgate.js';

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
  const session = ctx.sessions.get(chatId) || {};
  const cart = getCart(ctx, chatId);
  if (cart.length) rows.push([{ text: `🛒 View cart (${cart.length})`, callback_data: 'shop:cart' }]);
  rows.push([{ text: '🛠️ Hire an Admin', callback_data: 'shop:addadmin' }]);
  // One incentive at a time: if they arrived via the post-booking upsell, show
  // only that discount. Otherwise show the standing first-deposit bonus.
  let offer = '';
  if (session.upsellPercent) {
    offer = `\n🎉 *${session.upsellPercent}% off* these parts is locked in — it’s applied automatically at checkout.`;
  } else {
    const pct = await getIntSetting('deposit_bonus_pct', 0);
    const cap = await getIntSetting('deposit_bonus_cap_cents', 0);
    const bonusQty = await getIntSetting('bonus_qualifying_qty', 6);
    if (pct > 0) {
      offer = `\n🎁 Grab a *${bonusQty}-pack* to unlock a *${pct}% bonus*${cap > 0 ? ` (up to ${usd(cap)})` : ''} on your first wallet deposit!`;
    }
  }
  await ctx.bot.sendMessage(
    chatId,
    `🧱 *Shop*\nTap a product to see pack sizes & prices, then add it to your cart.${offer}`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: rows },
    }
  );
}

export async function chooseProduct(ctx, chatId, sku) {
  const p = await getProduct(sku);
  if (!p || !p.active) {
    await ctx.bot.sendMessage(chatId, 'That product isn’t available.');
    return;
  }
  const s = ctx.sessions.get(chatId) || {};
  if (p.price_mode === 'packs') {
    // Hide pack sizes below the per-order minimum so customers can't pick one
    // the checkout gate would only reject.
    const min = p.min_qty || 1;
    const rows = packOptions(p)
      .filter((pk) => pk.qty >= min)
      .map((pk) => [
        { text: `${pk.qty} for ${usd(pk.cents)}`, callback_data: `shop:pack:${sku}:${pk.qty}` },
      ]);
    ctx.sessions.set(chatId, { ...s, flow: 'shop', cart: s.cart || [] });
    await ctx.bot.sendMessage(chatId, `*${p.name}*${(p.min_qty || 1) > 1 ? `\n_Minimum ${p.min_qty} per order._` : ''}\nChoose a pack:`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: rows },
    });
  } else {
    ctx.sessions.set(chatId, { ...s, flow: 'shop', cart: s.cart || [], sku });
    await ctx.bot.sendMessage(
      chatId,
      `*${p.name}*\n• ${usd(p.unit_price_cents)} each\n• ${p.bundle_qty} for ${usd(
        p.bundle_price_cents
      )}${(p.min_qty || 1) > 1 ? `\n• *Minimum ${p.min_qty} per order*` : ''}\n\nHow many?`,
      { parse_mode: 'Markdown', ...qtyKeyboard(p.min_qty || 1) }
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
  const min = p.min_qty || 1;
  if (already + qty < min) {
    await ctx.bot.sendMessage(
      chatId,
      `ℹ️ *${p.name}* has a *${min}-per-order minimum*. Please choose at least ${min}${already ? ` (you have ${already} so far)` : ''}.`,
      { parse_mode: 'Markdown' }
    );
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

async function askAddress(ctx, chatId) {
  await ctx.bot.sendMessage(
    chatId,
    '📍 What’s your *delivery address*? One message — street, city, ZIP.',
    {
      parse_mode: 'Markdown',
      reply_markup: { force_reply: true, input_field_placeholder: '123 Main St, San Francisco, 94110' },
    }
  );
}

// One-line address → normalized. If they only give a street, assume SF.
function normalizeAddress(text) {
  let a = String(text).replace(/\s+/g, ' ').trim();
  if (!/san francisco|sf\b/i.test(a)) a += ', San Francisco, CA';
  else if (!/\bCA\b|california/i.test(a)) a += ', CA';
  return a;
}

// Checkout the whole cart → one-line delivery address.
export async function checkout(ctx, chatId) {
  const cart = getCart(ctx, chatId);
  if (!cart.length) {
    await ctx.bot.sendMessage(chatId, 'Your cart is empty. Tap /shop to add items.');
    return;
  }
  // Per-product minimum-order-quantity gate (sums stacked line items).
  const totals = new Map();
  for (const i of cart) totals.set(i.sku, (totals.get(i.sku) || 0) + i.qty);
  const shortfalls = [];
  for (const [sku, total] of totals) {
    const p = await getProduct(sku);
    const min = p?.min_qty || 1;
    if (total < min) shortfalls.push(`• *${p?.name || sku}*: minimum ${min}, you have ${total}`);
  }
  if (shortfalls.length) {
    await ctx.bot.sendMessage(
      chatId,
      `🛒 Before checkout, please meet the per-order minimums:\n${shortfalls.join('\n')}\n\nTap /shop to add more.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  const last = await lastDeliveryAddress(chatId);
  const s = ctx.sessions.get(chatId) || {};
  ctx.sessions.set(chatId, { ...keepCheckout(s), flow: 'shop', cart, step: 'awaiting_address', lastAddr: last });
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
    await askAddress(ctx, chatId);
  }
}

export async function promptNewAddress(ctx, chatId) {
  const s = ctx.sessions.get(chatId) || {};
  ctx.sessions.set(chatId, { ...s, step: 'awaiting_address' });
  await askAddress(ctx, chatId);
}

export async function useLastAddress(ctx, chatId) {
  const s = ctx.sessions.get(chatId);
  if (!s?.lastAddr) {
    await askAddress(ctx, chatId);
    return;
  }
  await addressComplete(ctx, chatId, s.lastAddr);
}

export async function receiveAddress(ctx, chatId, text) {
  const s = ctx.sessions.get(chatId);
  if (s?.flow !== 'shop' || s.step !== 'awaiting_address') return;
  await addressComplete(ctx, chatId, normalizeAddress(text));
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
    '📱 *Optional:* add a phone for the courier — or skip and we’ll reach you right here on Telegram.',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        keyboard: [
          [{ text: '📱 Share my number', request_contact: true }],
          [{ text: '⏭️ Skip — message me on Telegram' }],
        ],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    }
  );
}

export async function receivePhone(ctx, chatId, telegramId, phone, handle) {
  const s = ctx.sessions.get(chatId);
  if (!s?.cart?.length || s.step !== 'awaiting_phone') return;
  const skipped = !phone || phone.startsWith('⏭️ Skip');
  ctx.sessions.set(chatId, { ...s, phone: skipped ? null : phone, handle: handle || null });
  await showReview(ctx, chatId);
}

// Review-and-confirm: the customer sees the full total BEFORE the order
// exists. The sale terms are agreed on the same tap (full text via 📄).
export async function showReview(ctx, chatId) {
  const s = ctx.sessions.get(chatId);
  if (!s?.cart?.length) return;
  ctx.sessions.set(chatId, { ...s, step: 'reviewing' });
  const termsUrl = `${config.server.publicUrl}/terms/o?k=${issueTermsToken(chatId)}`;
  const subtotal = cartSubtotalCents(s.cart);
  const threshold = await getIntSetting('free_delivery_threshold_cents', 0);
  const deliveryFee = deliveryAfterThreshold(subtotal, s.deliveryFee, threshold);
  const discount = s.upsellPercent ? Math.round((subtotal * s.upsellPercent) / 100) : 0;
  const total = subtotal + deliveryFee - discount;
  const lines = s.cart.map((i) => `• ${i.name} ×${i.qty}`).join('\n');
  await ctx.bot.sendMessage(
    chatId,
    `🧾 *Review your order*\n${lines}\n📍 ${s.address}\n` +
      `${s.note ? `📝 ${s.note}\n` : ''}` +
      `Subtotal ${usd(subtotal)} · Delivery ${deliveryFee ? usd(deliveryFee) : 'free'}` +
      `${discount ? ` · Discount −${usd(discount)}` : ''}\n💵 *Total ${usd(total)}*\n\n` +
      `_Open the 📄 sale terms, then tap “I agree”._`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📄 Read the sale terms', url: termsUrl }],
          [{ text: `✅ I agree — continue to payment`, callback_data: 'shop:confirm' }],
          [
            { text: s.note ? '📝 Edit note' : '📝 Add a note', callback_data: 'shop:note' },
            { text: '✖ Cancel', callback_data: 'shop:cocancel' },
          ],
        ],
      },
    }
  );
}

export async function promptNote(ctx, chatId) {
  const s = ctx.sessions.get(chatId);
  if (!s?.cart?.length || s.step !== 'reviewing') return;
  ctx.sessions.set(chatId, { ...s, step: 'awaiting_note' });
  await ctx.bot.sendMessage(chatId, '📝 Delivery note (gate code, unit #, drop-off spot):', {
    reply_markup: { force_reply: true },
  });
}

export async function cancelCheckout(ctx, chatId) {
  const s = ctx.sessions.get(chatId);
  ctx.sessions.set(chatId, { flow: 'shop', cart: s?.cart || [], upsellPercent: s?.upsellPercent });
  await ctx.bot.sendMessage(chatId, '✖ Checkout cancelled — your cart is saved. Tap /shop anytime.', {
    reply_markup: { remove_keyboard: true },
  });
}

export async function confirmOrder(ctx, chatId, telegramId) {
  const s = ctx.sessions.get(chatId);
  if (!s?.cart?.length || s.step !== 'reviewing') return;
  if (!hasViewedTerms(chatId)) {
    await ctx.bot.sendMessage(chatId, '☝️ Please open “📄 Read the sale terms” first — then tap “I agree” again.');
    return;
  }
  const note = s.note || null;
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

  // Upsell + an unpaid booking → fold the parts into the booking's payment so
  // the customer pays ONCE for both (#combined-pay).
  let combined = false;
  if (s.upsellPercent) {
    const bookings = await listBookingsByCustomer(telegramId, 5);
    const open = bookings.find((b) => b.payment_status === 'unpaid' && b.status === 'awaiting_payment');
    if (open && (await linkOrderToBooking(open.id, order.id))) combined = true;
  }

  await ctx.bot.sendMessage(
    chatId,
    combined
      ? `✅ Order *${shortRef(order.id)}* created and added to your booking — *one payment covers both*.`
      : `✅ Order *${shortRef(order.id)}* created — thanks!`,
    { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
  );
  await acceptWaiver(ctx, chatId, telegramId, 'o', order.id);
}

// Optional note typed from the review card → back to the review card.
export async function receiveNote(ctx, chatId, telegramId, text) {
  const s = ctx.sessions.get(chatId);
  if (!s?.cart?.length || s.step !== 'awaiting_note') return;
  ctx.sessions.set(chatId, { ...s, note: String(text).slice(0, 300) });
  await showReview(ctx, chatId);
}
