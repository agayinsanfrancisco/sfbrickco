import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from './supabase.js';
import { createWebAdmin } from './webadmin.js';
import { markTermsViewed } from './lib/termsgate.js';
import { waiverText } from './flows/payments.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Express app: serves the public marketing/policy site + a health check.
// Payments are crypto-only (BTC/LTC) with in-bot admin confirmation, so there
// is no payment webhook to host in this first run.
export function createServer(ctx) {
  const app = express();
  app.set('trust proxy', 1); // behind Traefik — real client IP for login rate limit
  app.use(createWebAdmin(ctx));
  // Deep health check (#35): verify DB connectivity so Coolify restarts on real
  // failure, not just process liveness. Returns 503 when the DB is unreachable.
  app.get('/health', async (_req, res) => {
    try {
      const { error } = await supabase.from('settings').select('key').limit(1);
      if (error) throw error;
      res.json({ ok: true, db: 'up' });
    } catch (err) {
      res.status(503).json({ ok: false, db: 'down', error: err.message });
    }
  });
  // Hosted sale/booking terms. Opening the page marks the checkout's terms
  // token as read, which unlocks the Agree button in the bot.
  app.get('/terms/:kind', (req, res) => {
    const kind = req.params.kind === 'b' ? 'b' : 'o';
    const acked = req.query.k ? markTermsViewed(String(req.query.k)) : false;
    const body = waiverText(kind)
      .replace(/\\([_*.])/g, '$1')
      .replace(/\*([^*]+)\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
    res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${kind === 'b' ? 'Booking' : 'Sale'} Terms — SF Brick Company</title>
<style>body{margin:0;background:#fafaf9;color:#1c1917;font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:640px;margin:0 auto;padding:32px 20px}h1{font-size:20px}
.ok{background:#f0fdf4;border:1px solid #bbf7d0;color:#15803d;border-radius:8px;padding:10px 14px;margin:16px 0;font-size:14px}
p{background:#fff;border:1px solid #e7e5e4;border-radius:10px;padding:20px}</style></head><body><main>
<h1>🧱 SF Brick Company — ${kind === 'b' ? 'Booking' : 'Sale'} Terms</h1>
${acked ? '<div class="ok">✅ Noted — head back to Telegram and tap “I agree”.</div>' : ''}
<p>${body}</p></main></body></html>`);
  });
  app.use(express.static(PUBLIC_DIR));
  return app;
}
