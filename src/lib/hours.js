// Best-effort parsing of application answers into structured data.
// Pure module (no I/O) so it's unit-testable.
//
// The availability model is 3 fixed blocks per day (9–13, 13–17, 17–21
// Pacific), so free-text hours are mapped to every block they overlap.

const BLOCKS = [
  { start: 9, end: 13 },
  { start: 13, end: 17 },
  { start: 17, end: 21 },
];

const DAY_TOKENS = [
  ['sun', 0], ['mon', 1], ['tue', 2], ['wed', 3], ['thu', 4], ['fri', 5], ['sat', 6],
];

function to24h(hourStr, minStr, ampm, { isEnd = false } = {}) {
  let h = Number.parseInt(hourStr, 10);
  if (Number.isNaN(h)) return null;
  const frac = minStr ? Number.parseInt(minStr, 10) / 60 : 0;
  if (ampm === 'pm' && h < 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  // "9-5" with no am/pm: treat an end hour ≤ 8 as pm (17:00), and a start
  // hour ≤ 6 as pm too — nobody offers 5am build sessions.
  if (!ampm && h <= (isEnd ? 8 : 6)) h += 12;
  return h + frac;
}

// Parse a free-text hours answer ("Mon–Fri 9am–5pm, weekends flexible") into
// availability windows [{dow, start_hour, end_hour}]. Returns [] when nothing
// parses — the caller should then leave availability unset.
export function parseHoursToWindows(text) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return [];

  // Days
  const days = new Set();
  if (/every ?day|daily|all week|7 days|any ?time|24\/7/.test(t)) {
    for (let d = 0; d <= 6; d++) days.add(d);
  }
  if (/week ?days?|mon\s*[-–—to]+\s*fri/.test(t)) for (const d of [1, 2, 3, 4, 5]) days.add(d);
  if (/week ?ends?/.test(t)) { days.add(0); days.add(6); }
  // Explicit ranges like "tue-sat"
  const range = t.match(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\s*[-–—]\s*(sun|mon|tue|wed|thu|fri|sat)[a-z]*/);
  if (range) {
    const idx = (tok) => DAY_TOKENS.find(([k]) => k === tok)[1];
    let d = idx(range[1]);
    const end = idx(range[2]);
    for (let i = 0; i < 7; i++) {
      days.add(d);
      if (d === end) break;
      d = (d + 1) % 7;
    }
  } else if (!days.size) {
    for (const [tok, d] of DAY_TOKENS) if (new RegExp(`\\b${tok}`).test(t)) days.add(d);
  }
  if (!days.size) for (let d = 0; d <= 6; d++) days.add(d); // no days named → assume all

  // Time range
  const tm = t.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:[-–—]|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  let start = 9;
  let end = 21;
  if (tm) {
    const s = to24h(tm[1], tm[2], tm[3]);
    const e = to24h(tm[4], tm[5], tm[6], { isEnd: true });
    if (s != null && e != null && e > s) { start = s; end = e; }
  }

  const windows = [];
  for (const dow of [...days].sort()) {
    for (const b of BLOCKS) {
      if (start < b.end && end > b.start) windows.push({ dow, start_hour: b.start, end_hour: b.end });
    }
  }
  return windows;
}

// Parse a rate answer ("$38", "38", "40/hr") into cents; null when invalid.
export function parseRateCents(text) {
  const dollars = Number.parseFloat(String(text || '').replace(/[^0-9.]/g, ''));
  if (Number.isNaN(dollars) || dollars <= 0 || dollars > 10000) return null;
  return Math.round(dollars * 100);
}
