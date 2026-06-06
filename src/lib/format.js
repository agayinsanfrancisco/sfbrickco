export function usd(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

// Human-friendly order/booking reference from a UUID, e.g. "SFB-3F9A2C".
export function shortRef(id) {
  return `SFB-${String(id).replace(/-/g, '').slice(0, 6).toUpperCase()}`;
}

// One-line item summary for an order (multi-item cart aware).
export function orderItemsSummary(o) {
  if (o.items?.length) return o.items.map((i) => `${i.qty}× ${i.name}`).join(', ');
  return `${o.qty}× ${o.sku}`;
}

// Format an ISO timestamp in Pacific time as e.g. "Mon Jun 2, 3:00 PM PDT".
// Intl handles PST/PDT automatically, so DST is always correct.
export function fmtSlot(iso) {
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function fmtHourRange(startIso, endIso) {
  return `${fmtSlot(startIso)} – ${new Date(endIso).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  })}`;
}
