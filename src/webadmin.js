import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import {
  listPendingApplications,
  setApplicationStatus,
  promoteToExpert,
  listRecentOrders,
  listPaidUndispatchedOrders,
  markOrderDispatched,
  markOrderRefunded,
  markBookingRefunded,
  listOpenBookings,
  listAwaitingPaymentBookings,
  listUsers,
  getBooking,
  getOrder,
} from './supabase.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_PATH = path.join(__dirname, 'admin-ui.html');

const COOKIE_NAME = 'adm';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ── Session cookie: <expiryMs>.<hmac(expiryMs, keyed by the dash token)> ──
// The token itself is the HMAC key, so rotating ADMIN_DASH_TOKEN invalidates
// every outstanding session. Pure functions so they're unit-testable.
export function makeSessionCookie(token, now = Date.now()) {
  const exp = String(now + SESSION_TTL_MS);
  const sig = crypto.createHmac('sha256', token).update(exp).digest('hex');
  return `${exp}.${sig}`;
}

export function verifySessionCookie(token, value, now = Date.now()) {
  if (!token || typeof value !== 'string') return false;
  const [exp, sig] = value.split('.');
  if (!exp || !sig || !/^\d+$/.test(exp)) return false;
  if (Number(exp) < now) return false;
  const expected = crypto.createHmac('sha256', token).update(exp).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function tokensMatch(given, actual) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(actual));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readCookie(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE_NAME) return decodeURIComponent(v.join('='));
  }
  return null;
}

// Web admin dashboard: token login + JSON API over the same Supabase helpers
// the bot uses. `ctx.bot` (may be null in tests) sends the same Telegram
// notifications the in-bot owner panel would.
export function createWebAdmin(ctx) {
  const router = express.Router();
  const token = config.server.adminToken;

  // Dashboard disabled entirely unless a token is configured.
  if (!token) {
    router.use('/admin', (_req, res) => res.status(404).send('Not found'));
    return router;
  }

  router.use('/admin', express.json());

  const requireAuth = (req, res, next) => {
    if (verifySessionCookie(token, readCookie(req))) return next();
    res.status(401).json({ error: 'unauthorized' });
  };

  // Login page + app shell. The shell contains no data; all data is behind
  // the cookie-gated API. Login is rate-limited (10 tries / 15 min / IP).
  const loginHits = new Map();
  const loginAllowed = (ip) => {
    const now = Date.now();
    const recent = (loginHits.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
    recent.push(now);
    loginHits.set(ip, recent);
    return recent.length <= 10;
  };

  router.get('/admin', (_req, res) => {
    res.sendFile(UI_PATH);
  });

  router.post('/admin/login', (req, res) => {
    if (!loginAllowed(req.ip)) return res.status(429).json({ error: 'too many attempts — wait 15 minutes' });
    const given = req.body?.token || '';
    if (!tokensMatch(given, token)) return res.status(401).json({ error: 'wrong token' });
    const cookie = makeSessionCookie(token);
    res.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=${encodeURIComponent(cookie)}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`
    );
    res.json({ ok: true });
  });

  router.post('/admin/logout', (_req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/admin; HttpOnly; Max-Age=0`);
    res.json({ ok: true });
  });

  const api = express.Router();
  api.use(requireAuth);

  const notify = async (telegramId, text, opts) => {
    try {
      await ctx?.bot?.sendMessage(telegramId, text, opts);
    } catch {
      /* recipient hasn't opened the bot / bot unavailable */
    }
  };

  api.get('/overview', async (_req, res) => {
    const [apps, undispatched, open, awaiting, users] = await Promise.all([
      listPendingApplications(),
      listPaidUndispatchedOrders(),
      listOpenBookings(),
      listAwaitingPaymentBookings(),
      listUsers(),
    ]);
    res.json({
      pendingApplications: apps.length,
      ordersAwaitingDispatch: undispatched.length,
      openBookings: open.length,
      bookingsAwaitingPayment: awaiting.length,
      users: users.length,
      experts: users.filter((u) => u.role === 'expert' && u.active).length,
    });
  });

  api.get('/orders', async (_req, res) => {
    res.json(await listRecentOrders(100));
  });

  api.get('/bookings', async (_req, res) => {
    const [open, awaiting] = await Promise.all([listOpenBookings(), listAwaitingPaymentBookings()]);
    res.json({ open, awaitingPayment: awaiting });
  });

  api.get('/applications', async (_req, res) => {
    res.json(await listPendingApplications());
  });

  api.get('/users', async (_req, res) => {
    res.json(await listUsers());
  });

  api.post('/applications/:id/approve', async (req, res) => {
    const app = await setApplicationStatus(req.params.id, 'approved');
    if (!app) return res.status(409).json({ error: 'already handled' });
    const user = await promoteToExpert(app.telegram_id, app.base_address);
    await notify(
      app.telegram_id,
      '🎉 *You’re approved as a Block Expert!*\n\n' +
        'Two quick steps to start getting booked:\n' +
        '① Tap /builder → *🗓️ Availability* and turn on the hours you want to work.\n' +
        '② Confirm your *📍 base address* (used to price travel) and *💲 your rate*.',
      { parse_mode: 'Markdown' }
    );
    res.json({ ok: true, promoted: Boolean(user), name: app.name });
  });

  api.post('/applications/:id/reject', async (req, res) => {
    const app = await setApplicationStatus(req.params.id, 'rejected');
    if (!app) return res.status(409).json({ error: 'already handled' });
    await notify(
      app.telegram_id,
      'Thanks for applying to be a Block Expert — we’re not able to move forward at this time.'
    );
    res.json({ ok: true, name: app.name });
  });

  api.post('/orders/:id/dispatch', async (req, res) => {
    const order = await getOrder(req.params.id);
    if (!order || order.status !== 'paid') return res.status(409).json({ error: 'order is not in a dispatchable state' });
    const updated = await markOrderDispatched(order.id);
    if (!updated) return res.status(409).json({ error: 'could not dispatch' });
    await notify(order.telegram_id, '🚚 Your order is on its way!');
    res.json({ ok: true });
  });

  api.post('/orders/:id/refund', async (req, res) => {
    const row = await markOrderRefunded(req.params.id, req.body?.txid || null);
    if (!row) return res.status(409).json({ error: 'could not mark refunded' });
    await notify(row.telegram_id, '↩️ Your order has been refunded.');
    res.json({ ok: true });
  });

  api.post('/bookings/:id/refund', async (req, res) => {
    const booking = await getBooking(req.params.id);
    if (!booking) return res.status(404).json({ error: 'not found' });
    const row = await markBookingRefunded(req.params.id, req.body?.txid || null);
    if (!row) return res.status(409).json({ error: 'could not mark refunded' });
    await notify(row.customer_telegram_id, '↩️ Your booking has been refunded.');
    res.json({ ok: true });
  });

  router.use('/admin/api', api);


  return router;
}
