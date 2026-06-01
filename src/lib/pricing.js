import { config } from '../config.js';

// Single SKU for v1 (forward-compatible with a multi-SKU catalog later).
export const RED_BRICK_SKU = 'red-brick';

// Bundle math: every group of `bundleQty` gets the bundle price; the remainder
// is charged at the unit price. e.g. 7 = 1 bundle ($45) + 1 unit ($10).
export function priceForQty(qty) {
  const { unitCents, bundleQty, bundleCents } = config.pricing;
  const bundles = Math.floor(qty / bundleQty);
  const rest = qty % bundleQty;
  return bundles * bundleCents + rest * unitCents;
}
