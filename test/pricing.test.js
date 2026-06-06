import { describe, it, expect } from 'vitest';
import { priceForProduct, packOptions } from '../src/lib/pricing.js';

describe('priceForProduct — unit_bundle', () => {
  const p = { price_mode: 'unit_bundle', unit_price_cents: 1000, bundle_qty: 6, bundle_price_cents: 4500 };
  it('prices singles at unit price', () => expect(priceForProduct(p, 1)).toBe(1000));
  it('prices 3 at 3× unit', () => expect(priceForProduct(p, 3)).toBe(3000));
  it('uses the bundle at exact bundle qty', () => expect(priceForProduct(p, 6)).toBe(4500));
  it('mixes a bundle + singles', () => expect(priceForProduct(p, 7)).toBe(4500 + 1000));
  it('handles two bundles', () => expect(priceForProduct(p, 12)).toBe(9000));
  it('falls back to unit price with no bundle config', () =>
    expect(priceForProduct({ price_mode: 'unit_bundle', unit_price_cents: 300 }, 4)).toBe(1200));
});

describe('priceForProduct — packs', () => {
  const p = { price_mode: 'packs', packs: [{ qty: 4, cents: 800 }, { qty: 10, cents: 1500 }] };
  it('prices a valid pack size', () => expect(priceForProduct(p, 4)).toBe(800));
  it('prices the larger pack', () => expect(priceForProduct(p, 10)).toBe(1500));
  it('returns null for a non-pack quantity', () => expect(priceForProduct(p, 5)).toBeNull());
});

describe('packOptions', () => {
  it('returns the packs list for packs mode', () =>
    expect(packOptions({ price_mode: 'packs', packs: [{ qty: 4, cents: 800 }] })).toHaveLength(1));
  it('returns null for unit_bundle', () =>
    expect(packOptions({ price_mode: 'unit_bundle' })).toBeNull());
});
