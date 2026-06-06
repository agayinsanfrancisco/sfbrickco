import { describe, it, expect } from 'vitest';
import { manualSurchargeCents } from '../src/uber.js';

describe('manualSurchargeCents', () => {
  it('parses a dollar amount to cents', () => expect(manualSurchargeCents('14.50')).toBe(1450));
  it('strips currency symbols', () => expect(manualSurchargeCents('$20')).toBe(2000));
  it('returns null for non-numeric input', () => expect(manualSurchargeCents('abc')).toBeNull());
  it('rounds to the nearest cent', () => expect(manualSurchargeCents('9.999')).toBe(1000));
});
