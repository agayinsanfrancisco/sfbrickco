// 1-hour bookable slots, 24/7, but requiring at least 24 hours' lead time.
// Slots align to the top of the hour in UTC; display converts to Pacific.
// Availability is derived from the bookings table at request time.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
export const MIN_LEAD_MS = 24 * HOUR_MS; // bookings must be ≥24h out

// Day buckets for the picker, starting from the first day that can contain a
// bookable (≥24h-out) slot.
export function upcomingDays(count = 7, now = new Date()) {
  const start = new Date(now.getTime() + MIN_LEAD_MS);
  const days = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(start.getTime() + i * DAY_MS);
    const dateKey = d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    days.push({
      dateKey,
      label: d.toLocaleDateString('en-US', {
        timeZone: 'America/Los_Angeles',
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      }),
    });
  }
  return days;
}

// The hourly slots for a given YYYY-MM-DD, dropping anything less than 24h away.
export function hourlySlots(dateKey, now = new Date()) {
  const cutoff = now.getTime() + MIN_LEAD_MS;
  const slots = [];
  for (let h = 0; h < 24; h++) {
    const start = new Date(`${dateKey}T${String(h).padStart(2, '0')}:00:00.000Z`);
    if (start.getTime() <= cutoff) continue; // enforce 24h lead
    const end = new Date(start.getTime() + HOUR_MS);
    slots.push({
      startIso: start.toISOString(),
      endIso: end.toISOString(),
      label: start.toLocaleString('en-US', {
        timeZone: 'America/Los_Angeles',
        hour: 'numeric',
        minute: '2-digit',
      }),
    });
  }
  return slots;
}
