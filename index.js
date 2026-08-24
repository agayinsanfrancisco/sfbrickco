import { config, validateConfig } from './src/config.js';
import { createBot } from './src/bot.js';
import { createServer } from './src/server.js';
import {
  listBookingsNeedingReview,
  cancelStalePendingOrders,
  cancelStaleUnpaidBookings,
  listBookingsNeedingReminder,
  markReminded,
  getUserById,
} from './src/supabase.js';
import { promptReview } from './src/flows/review.js';
import { listPendingApplications } from './src/supabase.js';
import { watchOnce } from './src/watcher.js';
import { log } from './src/lib/log.js';
import { fmtHourRange } from './src/lib/format.js';

const REVIEW_POLL_MS = 60 * 1000;
const WATCH_POLL_MS = 60 * 1000;
const CLEANUP_POLL_MS = 60 * 60 * 1000; // hourly
const REMINDER_POLL_MS = 15 * 60 * 1000; // every 15 min

function startReviewScheduler(ctx) {
  const tick = async () => {
    try {
      const due = await listBookingsNeedingReview(new Date().toISOString());
      for (const booking of due) {
        await promptReview(ctx, booking);
      }
    } catch (err) {
      console.error('review scheduler error:', err);
    }
  };
  setInterval(tick, REVIEW_POLL_MS);
  tick(); // run once on boot
}

function startPaymentWatcher(ctx) {
  const tick = async () => {
    try {
      await watchOnce(ctx);
    } catch (err) {
      log.error(`payment watcher error: ${err.message}`);
    }
  };
  setInterval(tick, WATCH_POLL_MS);
  tick();
}

// Abandoned-order sweep (#18): cancel unpaid orders/bookings past the window.
function startCleanupSweep() {
  const tick = async () => {
    try {
      const before = new Date(Date.now() - config.cleanup.abandonAfterMs).toISOString();
      const [orders, bookings] = await Promise.all([
        cancelStalePendingOrders(before),
        cancelStaleUnpaidBookings(before),
      ]);
      if (orders.length || bookings.length) {
        log.info('cleanup swept', { orders: orders.length, bookings: bookings.length });
      }
    } catch (err) {
      log.error(`cleanup sweep error: ${err.message}`);
    }
  };
  setInterval(tick, CLEANUP_POLL_MS);
  tick();
}

// Booking reminders (#41): DM customer + builder ~1h before the slot.
function startReminderScheduler(ctx) {
  const tick = async () => {
    try {
      const now = Date.now();
      const due = await listBookingsNeedingReminder(
        new Date(now).toISOString(),
        new Date(now + 60 * 60 * 1000).toISOString()
      );
      for (const b of due) {
        const when = fmtHourRange(b.slot_start, b.slot_end);
        try {
          await ctx.bot.sendMessage(b.customer_telegram_id, `⏰ Reminder: your build-help session is at ${when}.`);
        } catch {
          /* ignore */
        }
        if (b.expert_id) {
          const builder = await getUserById(b.expert_id);
          if (builder) {
            try {
              await ctx.bot.sendMessage(builder.telegram_id, `⏰ Reminder: you have a job at ${when} — ${b.customer_address}.`);
            } catch {
              /* ignore */
            }
          }
        }
        await markReminded(b.id);
      }
    } catch (err) {
      log.error(`reminder scheduler error: ${err.message}`);
    }
  };
  setInterval(tick, REMINDER_POLL_MS);
  tick();
}

// Owner nudge: applications pending for more than a day (checked every 6h).
function startApplicationReminder(ctx) {
  const tick = async () => {
    try {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const stale = (await listPendingApplications()).filter((a) => new Date(a.created_at).getTime() < cutoff);
      if (!stale.length) return;
      for (const adminId of config.adminIds) {
        try {
          await ctx.bot.sendMessage(
            adminId,
            `⏰ ${stale.length} Block Expert application(s) have been waiting over 24h — review them in /owner → People → Apps.`
          );
        } catch {
          /* owner hasn't opened the bot */
        }
      }
    } catch (err) {
      log.error(`application reminder error: ${err.message}`);
    }
  };
  setInterval(tick, 6 * 60 * 60 * 1000);
  tick();
}

function main() {
  for (const w of validateConfig()) log.warn(`config: ${w}`);
  const { bot, ctx } = createBot();
  console.log('🤖 Telegram bot started (long polling).');

  const app = createServer(ctx);
  app.listen(config.server.port, () => {
    console.log(`🌐 Web server on :${config.server.port} (landing page + /health + /admin)`);
  });

  startReviewScheduler(ctx);
  startPaymentWatcher(ctx);
  startCleanupSweep();
  startReminderScheduler(ctx);
  startApplicationReminder(ctx);

  const shutdown = (sig) => {
    console.log(`\n${sig} received, shutting down…`);
    bot.stopPolling().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
