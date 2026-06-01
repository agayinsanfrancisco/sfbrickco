import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Express app: serves the public marketing/policy site + a health check.
// Payments are crypto-only (BTC/LTC) with in-bot admin confirmation, so there
// is no payment webhook to host in this first run.
export function createServer() {
  const app = express();
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use(express.static(PUBLIC_DIR));
  return app;
}
