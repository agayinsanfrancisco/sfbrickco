import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from './supabase.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Express app: serves the public marketing/policy site + a health check.
// Payments are crypto-only (BTC/LTC) with in-bot admin confirmation, so there
// is no payment webhook to host in this first run.
export function createServer() {
  const app = express();
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
  app.use(express.static(PUBLIC_DIR));
  return app;
}
