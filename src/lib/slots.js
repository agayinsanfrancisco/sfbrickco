// 1-hour bookable slots, available only within a rolling next-24-hours window.
// Slots align to the top of the hour in UTC; display converts to Pacific.

const HOUR_MS = 60 * 60 * 1000;
export const WINDOW_MS = 24 * HOUR_MS; // can only book within the next 24h

// Day buckets the 24h window touches (today and possibly tomorrow, UTC).
export function upcomingDays(_count = 2, now = new Date()) {
  const end = new Date(now.getTime() + WINDOW_MS);
  const keys = [...new Set([now.toISOString().slice(0, 10), end.toISOString().slice(0, 10)])];
  return keys.map((dateKey) => ({
    dateKey,
    label: new Date(`${dateKey}T12:00:00.000Z`).toLocaleDateString('en-US', {
      timeZone: 'America/Los_Angeles',
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    }),
  }));
}

// Hourly slots on a day, restricted to (now, now + 24h].
export function hourlySlots(dateKey, now = new Date()) {
  const lo = now.getTime();
  const hi = now.getTime() + WINDOW_MS;
  const slots = [];
  for (let h = 0; h < 24; h++) {
    const start = new Date(`${dateKey}T${String(h).padStart(2, '0')}:00:00.000Z`);
    const t = start.getTime();
    if (t <= lo || t > hi) continue; // only within the next 24h
    const end = new Date(t + HOUR_MS);
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
