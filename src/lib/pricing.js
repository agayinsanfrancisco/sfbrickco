// Pricing supports two product modes:
//  - 'unit_bundle': per-unit price with an optional bundle (e.g. Red: $10 ea / 6 for $45)
//  - 'packs':       fixed packs only (e.g. Blue: 4 for $8, 10 for $15)

// Returns the price in cents for `qty` of a product, or null if the quantity
// isn't valid for that product (packs products only sell exact pack sizes).
export function priceForProduct(product, qty) {
  if (product.price_mode === 'packs') {
    const pack = (product.packs || []).find((p) => p.qty === qty);
    return pack ? pack.cents : null;
  }
  // unit_bundle
  const bq = product.bundle_qty || 0;
  const bundles = bq ? Math.floor(qty / bq) : 0;
  const rest = bq ? qty % bq : qty;
  return bundles * (product.bundle_price_cents || 0) + rest * (product.unit_price_cents || 0);
}

// For 'packs' products: the list of {qty, cents} options. null for unit_bundle.
export function packOptions(product) {
  return product.price_mode === 'packs' ? product.packs || [] : null;
}
