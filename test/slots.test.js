import { describe, it, expect } from 'vitest';
import { isCovered, pacificDowHour, hourlySlots } from '../src/lib/slots.js';

// 2026-06-08T18:00:00Z = Monday 11:00 in Pacific (PDT, UTC-7).
const MON_11_PT = '2026-06-08T18:00:00Z';

describe('pacificDowHour', () => {
  it('converts a UTC timestamp to Pacific dow + hour', () => {
    expect(pacificDowHour(MON_11_PT)).toEqual({ dow: 1, hour: 11 });
  });
});

describe('isCovered', () => {
  it('allows all slots when no windows are configured', () => expect(isCovered([], MON_11_PT)).toBe(true));
  it('matches a covering window', () =>
    expect(isCovered([{ dow: 1, start_hour: 9, end_hour: 17 }], MON_11_PT)).toBe(true));
  it('rejects a slot outside the window hours', () =>
    expect(isCovered([{ dow: 1, start_hour: 9, end_hour: 10 }], MON_11_PT)).toBe(false));
  it('rejects a slot on the wrong day', () =>
    expect(isCovered([{ dow: 2, start_hour: 0, end_hour: 24 }], MON_11_PT)).toBe(false));
  it('treats end_hour as exclusive', () =>
    expect(isCovered([{ dow: 1, start_hour: 0, end_hour: 11 }], MON_11_PT)).toBe(false));
});

describe('hourlySlots', () => {
  it('only returns slots strictly within the next 12h', () => {
    const now = new Date('2026-06-08T10:00:00Z');
    const today = hourlySlots('2026-06-08', now);
    const tomorrow = hourlySlots('2026-06-09', now);
    const all = [...today, ...tomorrow];
    expect(all.length).toBeGreaterThan(0);
    const hi = now.getTime() + 12 * 60 * 60 * 1000;
    expect(all.every((s) => new Date(s.startIso).getTime() > now.getTime())).toBe(true);
    expect(all.every((s) => new Date(s.startIso).getTime() <= hi)).toBe(true);
  });
});
