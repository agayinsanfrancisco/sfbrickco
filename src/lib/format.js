export function usd(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

// Format an ISO timestamp in Pacific time as e.g. "Mon Jun 2, 3:00 PM".
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
  })}`;
}
