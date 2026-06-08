// 1-hour bookable slots, available only within a rolling next-24-hours window.
// Slots align to the top of the hour in UTC; display converts to Pacific.

const HOUR_MS = 60 * 60 * 1000;
export const WINDOW_MS = 12 * HOUR_MS; // can only book within the next 12h

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

// Pacific weekday (0=Sun) + hour for an ISO timestamp, for availability matching.
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
export function pacificDowHour(iso) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'short',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(new Date(iso));
  const wd = parts.find((p) => p.type === 'weekday')?.value;
  const hour = Number.parseInt(parts.find((p) => p.type === 'hour')?.value, 10) % 24;
  return { dow: DOW[wd], hour };
}

// Is a slot time covered by any of the given availability windows?
export function isCovered(windows, iso) {
  if (!windows.length) return true; // no availability configured anywhere → allow all
  const { dow, hour } = pacificDowHour(iso);
  return windows.some((w) => w.dow === dow && hour >= w.start_hour && hour < w.end_hour);
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
