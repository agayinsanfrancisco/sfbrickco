import { config } from './src/config.js';
import { createBot } from './src/bot.js';
import { createServer } from './src/server.js';
import { listBookingsNeedingReview } from './src/supabase.js';
import { promptReview } from './src/flows/review.js';

const REVIEW_POLL_MS = 60 * 1000;

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

function main() {
  const { bot, ctx } = createBot();
  console.log('🤖 Telegram bot started (long polling).');

  const app = createServer(ctx);
  app.listen(config.server.port, () => {
    console.log(`🌐 Webhook server on :${config.server.port} (POST /webhook/stripe)`);
  });

  startReviewScheduler(ctx);

  const shutdown = (sig) => {
    console.log(`\n${sig} received, shutting down…`);
    bot.stopPolling().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
