import { saveSession, deleteSession, loadAllSessions } from '../supabase.js';
import { log } from './log.js';

// In-memory session map mirrored to Supabase so in-progress flows survive a
// redeploy (#34), with an idle TTL sweep (#10). Keeps the synchronous
// get/set/delete interface the handlers expect; DB writes are fire-and-forget.
export class SessionStore {
  constructor(ttlMs) {
    this.map = new Map(); // chatId -> { state, ts }
    this.ttlMs = ttlMs;
  }

  async hydrate() {
    try {
      const rows = await loadAllSessions();
      for (const r of rows) this.map.set(Number(r.chat_id), { state: r.state, ts: Date.now() });
      if (rows.length) log.info(`sessions hydrated`, { count: rows.length });
    } catch (err) {
      log.error(`session hydrate failed: ${err.message}`);
    }
  }

  get(chatId) {
    return this.map.get(chatId)?.state;
  }

  set(chatId, state) {
    this.map.set(chatId, { state, ts: Date.now() });
    saveSession(chatId, state).catch(() => {});
  }

  delete(chatId) {
    this.map.delete(chatId);
    deleteSession(chatId).catch(() => {});
  }

  // Drop sessions idle longer than the TTL (both memory + DB).
  sweep() {
    const cutoff = Date.now() - this.ttlMs;
    let dropped = 0;
    for (const [chatId, entry] of this.map) {
      if (entry.ts < cutoff) {
        this.delete(chatId);
        dropped++;
      }
    }
    if (dropped) log.info('sessions swept (idle)', { dropped });
  }
}
