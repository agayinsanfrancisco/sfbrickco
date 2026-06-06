import { describe, it, expect } from 'vitest';
import { toSats, paymentUri, explorerUrl, COINS } from '../src/crypto.js';

describe('toSats', () => {
  it('converts 1 BTC to 100M sats', () => expect(toSats('1')).toBe(100_000_000));
  it('rounds to the nearest sat', () => expect(toSats('0.000000005')).toBe(1));
  it('handles fractional amounts', () => expect(toSats('0.0001')).toBe(10_000));
});

describe('paymentUri', () => {
  it('builds a BIP21 bitcoin URI', () => expect(paymentUri('btc', '0.01', 'addr')).toBe('bitcoin:addr?amount=0.01'));
  it('uses the litecoin scheme', () => expect(paymentUri('ltc', '1.5', 'laddr')).toBe('litecoin:laddr?amount=1.5'));
});

describe('explorerUrl', () => {
  it('returns a mempool.space url for btc', () => expect(explorerUrl('btc', 'x')).toContain('mempool.space'));
  it('returns null without an address', () => expect(explorerUrl('btc', '')).toBeNull());
});

describe('COINS', () => {
  it('defines btc and ltc with 8 decimals', () => {
    expect(COINS.btc.ticker).toBe('BTC');
    expect(COINS.ltc.ticker).toBe('LTC');
    expect(COINS.btc.decimals).toBe(8);
  });
});
