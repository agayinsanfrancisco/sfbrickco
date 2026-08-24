import { describe, it, expect, vi } from 'vitest';

// The session-cookie primitives are the web dashboard's whole security story —
// prove a forged, expired, malformed, or wrong-key cookie is rejected.
vi.mock('../src/config.js', () => ({ config: { server: { adminToken: 'test-token' } } }));
vi.mock('../src/supabase.js', () => ({
  listPendingApplications: vi.fn(), setApplicationStatus: vi.fn(), promoteToExpert: vi.fn(),
  listRecentOrders: vi.fn(), listPaidUndispatchedOrders: vi.fn(), markOrderDispatched: vi.fn(),
  markOrderRefunded: vi.fn(), markBookingRefunded: vi.fn(), listOpenBookings: vi.fn(),
  listAwaitingPaymentBookings: vi.fn(), listUsers: vi.fn(), getBooking: vi.fn(), getOrder: vi.fn(),
}));

const { makeSessionCookie, verifySessionCookie } = await import('../src/webadmin.js');

describe('web admin session cookie', () => {
  const TOKEN = 'secret-token';

  it('round-trips a freshly minted cookie', () => {
    const c = makeSessionCookie(TOKEN);
    expect(verifySessionCookie(TOKEN, c)).toBe(true);
  });

  it('rejects a cookie signed with a different token', () => {
    const c = makeSessionCookie('other-token');
    expect(verifySessionCookie(TOKEN, c)).toBe(false);
  });

  it('rejects an expired cookie', () => {
    const past = Date.now() - 8 * 24 * 60 * 60 * 1000; // minted 8 days ago (TTL 7d)
    const c = makeSessionCookie(TOKEN, past);
    expect(verifySessionCookie(TOKEN, c)).toBe(false);
  });

  it('rejects a cookie with a tampered expiry', () => {
    const c = makeSessionCookie(TOKEN);
    const [exp, sig] = c.split('.');
    const forged = `${Number(exp) + 999999999}.${sig}`;
    expect(verifySessionCookie(TOKEN, forged)).toBe(false);
  });

  it('rejects garbage and empty values', () => {
    for (const v of ['', 'nope', '123.', '.abc', null, undefined, '123.zz']) {
      expect(verifySessionCookie(TOKEN, v)).toBe(false);
    }
  });

  it('rejects everything when no token is configured', () => {
    expect(verifySessionCookie('', makeSessionCookie(''))).toBe(false);
  });
});
