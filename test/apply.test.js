import { describe, it, expect, vi, beforeEach } from 'vitest';

// The apply flow must be gated: an application only ever lands as `pending`
// for owner approval, an approved Block Expert can't re-apply, and a pending
// applicant can't file a duplicate.
vi.mock('../src/config.js', () => ({
  config: { pricing: { platformFeePct: 30 }, adminIds: [111] },
}));

vi.mock('../src/supabase.js', () => ({
  getUserByTelegramId: vi.fn(),
  getPendingApplication: vi.fn(),
  createApplication: vi.fn(),
}));

const db = await import('../src/supabase.js');
const { startApply } = await import('../src/flows/apply.js');

function makeCtx() {
  return {
    bot: { sendMessage: vi.fn().mockResolvedValue({}) },
    sessions: new Map(),
  };
}

describe('startApply gating', () => {
  beforeEach(() => {
    db.getUserByTelegramId.mockReset();
    db.getPendingApplication.mockReset();
  });

  it('blocks an active Block Expert from re-applying', async () => {
    db.getUserByTelegramId.mockResolvedValue({ role: 'expert', active: true });
    const ctx = makeCtx();
    await startApply(ctx, 42, 42);
    expect(ctx.sessions.has(42)).toBe(false); // no application session started
    expect(ctx.bot.sendMessage.mock.calls[0][1]).toMatch(/already a Block Expert/);
    expect(db.getPendingApplication).not.toHaveBeenCalled();
  });

  it('blocks a duplicate application while one is pending', async () => {
    db.getUserByTelegramId.mockResolvedValue({ role: 'customer', active: true });
    db.getPendingApplication.mockResolvedValue({ id: 'app-1', status: 'pending' });
    const ctx = makeCtx();
    await startApply(ctx, 42, 42);
    expect(ctx.sessions.has(42)).toBe(false);
    expect(ctx.bot.sendMessage.mock.calls[0][1]).toMatch(/under review/);
  });

  it('lets a new applicant start the flow', async () => {
    db.getUserByTelegramId.mockResolvedValue({ role: 'customer', active: true });
    db.getPendingApplication.mockResolvedValue(null);
    const ctx = makeCtx();
    await startApply(ctx, 42, 42);
    expect(ctx.sessions.get(42)).toMatchObject({ flow: 'apply', step: 'name' });
    expect(ctx.bot.sendMessage.mock.calls[0][1]).toMatch(/Apply to be a Block Expert/);
  });

  it('lets a deactivated former expert re-apply', async () => {
    db.getUserByTelegramId.mockResolvedValue({ role: 'expert', active: false });
    db.getPendingApplication.mockResolvedValue(null);
    const ctx = makeCtx();
    await startApply(ctx, 42, 42);
    expect(ctx.sessions.get(42)).toMatchObject({ flow: 'apply', step: 'name' });
  });
});
