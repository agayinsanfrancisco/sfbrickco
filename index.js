import { config } from './src/config.js';
import { createBot } from './src/bot.js';
import { createServer } from './src/server.js';
import { listBookingsNeedingReview } from './src/supabase.js';
import { promptReview } from './src/flows/review.js';
import { watchOnce } from './src/watcher.js';

const REVIEW_POLL_MS = 60 * 1000;
const WATCH_POLL_MS = 60 * 1000;

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
      console.error('payment watcher error:', err);
    }
  };
  setInterval(tick, WATCH_POLL_MS);
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

  const shutdown = (sig) => {
    console.log(`\n${sig} received, shutting down…`);
    bot.stopPolling().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
