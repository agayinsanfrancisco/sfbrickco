import { config, isAdminId } from '../config.js';
import { listUsers, logStaffActionRow } from '../supabase.js';
import { effectiveRole, can } from './roles.js';

// Fan a message out to every staffer who should see it: the env owners plus
// every active DB user whose role holds `cap`. De-duped by telegram id.
// Falls back to just the env owners if the user query fails, so an alert is
// never silently dropped.
export async function notifyStaff(ctx, cap, text, opts = {}) {
  const targets = new Set(config.adminIds);
  try {
    for (const u of await listUsers()) {
      if (!u.active) continue;
      const role = isAdminId(u.telegram_id) ? 'owner' : effectiveRole(u);
      if (can(role, cap)) targets.add(u.telegram_id);
    }
  } catch {
    /* fall back to env owners already in the set */
  }
  for (const id of targets) {
    try {
      await ctx.bot.sendMessage(id, text, opts);
    } catch {
      /* recipient hasn't opened the bot */
    }
  }
}

// Append one row to the staff action audit log. Best-effort — a logging
// failure must never break the action it records.
export async function logStaffAction(actorTelegramId, actorRole, action, target = null, detail = null) {
  try {
    await logStaffActionRow({ actorTelegramId, actorRole, action, target, detail });
  } catch {
    /* audit is best-effort */
  }
}
