import { describe, it, expect } from 'vitest';
import { parseHoursToWindows, parseRateCents } from '../src/lib/hours.js';

const days = (ws) => [...new Set(ws.map((w) => w.dow))].sort();
const blocks = (ws, dow) => ws.filter((w) => w.dow === dow).map((w) => `${w.start_hour}-${w.end_hour}`);

describe('parseHoursToWindows', () => {
  it("maps Kenny's answer: Mon-Fri 7am-4:30pm → weekday morning+afternoon", () => {
    const ws = parseHoursToWindows('Mon-Fri 7am-4:30pm, weekends available');
    expect(days(ws)).toEqual([0, 1, 2, 3, 4, 5, 6]); // "weekends available" counts too
    expect(blocks(ws, 1)).toEqual(['9-13', '13-17']); // 7:00–16:30 overlaps first two blocks
  });
  it('weekdays 9-5 → Mon-Fri, two blocks', () => {
    const ws = parseHoursToWindows('Weekdays 9–5');
    expect(days(ws)).toEqual([1, 2, 3, 4, 5]);
    expect(blocks(ws, 3)).toEqual(['9-13', '13-17']);
  });
  it('evenings only', () => {
    const ws = parseHoursToWindows('every day 5pm-9pm');
    expect(days(ws)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(blocks(ws, 0)).toEqual(['17-21']);
  });
  it('weekends 9-9', () => {
    const ws = parseHoursToWindows('Weekends 9am–9pm');
    expect(days(ws)).toEqual([0, 6]);
    expect(blocks(ws, 6)).toEqual(['9-13', '13-17', '17-21']);
  });
  it('day range tue-sat', () => {
    const ws = parseHoursToWindows('Tue-Sat 10am-6pm');
    expect(days(ws)).toEqual([2, 3, 4, 5, 6]);
  });
  it('no days named → all days; no time → all blocks', () => {
    expect(days(parseHoursToWindows('flexible, whenever'))).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(blocks(parseHoursToWindows('mondays'), 1)).toEqual(['9-13', '13-17', '17-21']);
  });
  it('empty input → no windows', () => {
    expect(parseHoursToWindows('')).toEqual([]);
    expect(parseHoursToWindows(null)).toEqual([]);
  });
});

describe('parseRateCents', () => {
  it('parses common formats', () => {
    expect(parseRateCents('$38')).toBe(3800);
    expect(parseRateCents('38')).toBe(3800);
    expect(parseRateCents('40/hr')).toBe(4000);
    expect(parseRateCents('45.50')).toBe(4550);
  });
  it('rejects junk', () => {
    expect(parseRateCents('cheap')).toBe(null);
    expect(parseRateCents('')).toBe(null);
    expect(parseRateCents('0')).toBe(null);
  });
});
