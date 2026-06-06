import { describe, it, expect } from 'vitest';
import { discountFor, orderTotalCents, cartSubtotalCents, deliveryAfterThreshold } from '../src/lib/money.js';

describe('discountFor', () => {
  it('is zero with no promo', () => expect(discountFor(1000, null)).toBe(0));
  it('applies a percentage', () => expect(discountFor(1000, { percent_off: 10 })).toBe(100));
  it('applies a flat amount', () => expect(discountFor(1000, { amount_off_cents: 250 })).toBe(250));
  it('stacks percent + flat', () => expect(discountFor(1000, { percent_off: 10, amount_off_cents: 250 })).toBe(350));
  it('never exceeds the subtotal', () => expect(discountFor(1000, { amount_off_cents: 5000 })).toBe(1000));
});

describe('orderTotalCents', () => {
  it('adds items + delivery', () => expect(orderTotalCents({ amount_cents: 1000, delivery_fee_cents: 500 })).toBe(1500));
  it('subtracts a discount', () =>
    expect(orderTotalCents({ amount_cents: 1000, delivery_fee_cents: 500, discount_cents: 300 })).toBe(1200));
  it('floors at zero', () =>
    expect(orderTotalCents({ amount_cents: 100, delivery_fee_cents: 0, discount_cents: 9999 })).toBe(0));
});

describe('cartSubtotalCents', () => {
  it('sums line totals', () =>
    expect(cartSubtotalCents([{ line_cents: 1000 }, { line_cents: 450 }])).toBe(1450));
  it('handles empty', () => expect(cartSubtotalCents([])).toBe(0));
});

describe('deliveryAfterThreshold', () => {
  it('keeps the fee below the threshold', () => expect(deliveryAfterThreshold(1000, 500, 5000)).toBe(500));
  it('waives the fee at/above the threshold', () => expect(deliveryAfterThreshold(5000, 500, 5000)).toBe(0));
  it('is disabled when threshold is 0', () => expect(deliveryAfterThreshold(99999, 500, 0)).toBe(500));
});
