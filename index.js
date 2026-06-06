import { config } from './src/config.js';
import { createBot } from './src/bot.js';
import { createServer } from './src/server.js';
import {
  listBookingsNeedingReview,
  cancelStalePendingOrders,
  cancelStaleUnpaidBookings,
} from './src/supabase.js';
import { promptReview } from './src/flows/review.js';
import { watchOnce } from './src/watcher.js';
import { log } from './src/lib/log.js';

const REVIEW_POLL_MS = 60 * 1000;
const WATCH_POLL_MS = 60 * 1000;
const CLEANUP_POLL_MS = 60 * 60 * 1000; // hourly

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

function main() {
  const { bot, ctx } = createBot();
  console.log('🤖 Telegram bot started (long polling).');

  const app = createServer();
  app.listen(config.server.port, () => {
    console.log(`🌐 Web server on :${config.server.port} (landing page + /health)`);
  });

  startReviewScheduler(ctx);
  startPaymentWatcher(ctx);
  startCleanupSweep();

  const shutdown = (sig) => {
    console.log(`\n${sig} received, shutting down…`);
    bot.stopPolling().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
