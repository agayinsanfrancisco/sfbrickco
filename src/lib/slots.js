// 1-hour bookable slots, available 24 hours a day.
// Slots are aligned to the top of the hour in UTC; display layers convert to
// Pacific. We never store generated slots — availability is derived from the
// bookings table at request time.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// The next `count` day buckets starting today, for the day picker.
export function upcomingDays(count = 7, now = new Date()) {
  const days = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getTime() + i * DAY_MS);
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

// The 24 hourly slots for a given YYYY-MM-DD, dropping any whose start is in
// the past. Returns [{ startIso, endIso, label }].
export function hourlySlots(dateKey, now = new Date()) {
  const slots = [];
  for (let h = 0; h < 24; h++) {
    const start = new Date(`${dateKey}T${String(h).padStart(2, '0')}:00:00.000Z`);
    if (start.getTime() <= now.getTime()) continue; // no past / current hour
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
