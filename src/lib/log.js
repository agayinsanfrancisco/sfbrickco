import { config } from '../config.js';

// Lightweight structured logging: timestamped level + message + optional meta.
function line(level, msg, meta) {
  const suffix = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${new Date().toISOString()} ${level} ${msg}${suffix}`;
}

export const log = {
  info: (msg, meta) => console.log(line('INFO', msg, meta)),
  warn: (msg, meta) => console.warn(line('WARN', msg, meta)),
  error: (msg, meta) => console.error(line('ERROR', msg, meta)),
};

// Log an error and DM the admins (best-effort). `ctx` may be omitted.
export async function reportError(ctx, context, err) {
  const message = err?.message || String(err);
  log.error(`${context}: ${message}`, err?.stack ? { stack: err.stack.split('\n')[1]?.trim() } : undefined);
  if (!ctx?.bot) return;
  for (const adminId of config.adminIds) {
    try {
      await ctx.bot.sendMessage(adminId, `🛑 *${context}*\n\`${message}\``, { parse_mode: 'Markdown' });
    } catch {
      /* admin hasn't opened the bot */
    }
  }
}
