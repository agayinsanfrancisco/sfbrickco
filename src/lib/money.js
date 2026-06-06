// Pure money helpers shared by the order, promo, threshold, and cart logic.
// Kept side-effect-free so they're unit-tested directly (see test/money.test.js).

// Discount (cents) a promo row applies to a subtotal. Percent + flat stack,
// and the result is clamped to the subtotal (never makes a total negative).
export function discountFor(subtotalCents, promo) {
  if (!promo) return 0;
  let d = 0;
  if (promo.percent_off) d += Math.round((subtotalCents * promo.percent_off) / 100);
  if (promo.amount_off_cents) d += promo.amount_off_cents;
  return Math.max(0, Math.min(d, subtotalCents));
}

// Final order total: items + delivery − discount, floored at 0.
export function orderTotalCents(o) {
  return Math.max(0, (o.amount_cents || 0) + (o.delivery_fee_cents || 0) - (o.discount_cents || 0));
}

// Sum of cart line totals.
export function cartSubtotalCents(items) {
  return (items || []).reduce((sum, it) => sum + (it.line_cents || 0), 0);
}

// Delivery fee after the free-delivery threshold (0 threshold = disabled).
export function deliveryAfterThreshold(subtotalCents, feeCents, thresholdCents) {
  if (thresholdCents > 0 && subtotalCents >= thresholdCents) return 0;
  return feeCents;
}
