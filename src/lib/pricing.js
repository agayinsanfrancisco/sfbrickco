import { config } from '../config.js';

// Bundle math: every group of `bundleQty` gets the bundle price; the remainder
// is charged at the unit price. e.g. 7 = 1 bundle ($45) + 1 unit ($10).
export function priceForQty(qty) {
  const { unitCents, bundleQty, bundleCents } = config.pricing;
  const bundles = Math.floor(qty / bundleQty);
  const rest = qty % bundleQty;
  return bundles * bundleCents + rest * unitCents;
}
