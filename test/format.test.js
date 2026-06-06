import { describe, it, expect } from 'vitest';
import { usd, shortRef } from '../src/lib/format.js';

describe('usd', () => {
  it('formats whole dollars', () => expect(usd(1000)).toBe('$10.00'));
  it('handles zero', () => expect(usd(0)).toBe('$0.00'));
  it('keeps two decimals', () => expect(usd(1599)).toBe('$15.99'));
  it('formats sub-dollar', () => expect(usd(5)).toBe('$0.05'));
});

describe('shortRef', () => {
  it('derives an SFB ref from a uuid', () =>
    expect(shortRef('3f9a2c00-1111-2222-3333-444455556666')).toBe('SFB-3F9A2C'));
  it('uppercases', () => expect(shortRef('abcdef00-0000-0000-0000-000000000000')).toBe('SFB-ABCDEF'));
});
