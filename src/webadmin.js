import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { applyApprovalSideEffects } from './flows/admin.js';
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
  listExperts,
  getBooking,
  getOrder,
  getUserById,
  acceptOpenBooking,
  setBookingSurcharge,
  setRole,
  setActive,
  builderPayoutData,
  recordPayout,
  listInventory,
  setStock,
  setProductPrice,
  supabase,
} from './supabase.js';
import { confirmOrder, confirmBooking } from './flows/payments.js';
import { manualSurchargeCents } from './uber.js';
import { config as cfg } from './config.js';
import { refreshChatCommands } from './lib/commands.js';
import { isStaff, ROLE_LABELS } from './lib/roles.js';
import { logStaffAction } from './lib/notify.js';
import { listStaffActions } from './supabase.js';

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
    await logStaffAction(null, 'dashboard', 'application.approve', app.name, app.base_address);
    if (ctx?.bot) await applyApprovalSideEffects(ctx.bot, app, user);
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
    await logStaffAction(null, 'dashboard', 'refund.order', req.params.id, req.body?.txid || null);
    await notify(row.telegram_id, '↩️ Your order has been refunded.');
    res.json({ ok: true });
  });

  api.post('/bookings/:id/refund', async (req, res) => {
    const booking = await getBooking(req.params.id);
    if (!booking) return res.status(404).json({ error: 'not found' });
    const row = await markBookingRefunded(req.params.id, req.body?.txid || null);
    if (!row) return res.status(409).json({ error: 'could not mark refunded' });
    await logStaffAction(null, 'dashboard', 'refund.booking', req.params.id, req.body?.txid || null);
    await notify(row.customer_telegram_id, '↩️ Your booking has been refunded.');
    res.json({ ok: true });
  });

  // ── Action queue: everything needing a human, in one payload ────────
  api.get('/queue', async (_req, res) => {
    const [apps, dispatch, open, awaitingPay, payoutData, fares] = await Promise.all([
      listPendingApplications(),
      listPaidUndispatchedOrders(),
      listOpenBookings(),
      listAwaitingPaymentBookings(),
      builderPayoutData(),
      supabase.from('bookings').select('*').eq('payment_status', 'unpaid').is('total_cents', null).then((r) => r.data || []),
    ]);
    // payouts owed per expert (net of platform fee, minus already paid)
    const fee = cfg.pricing.platformFeePct;
    const byExpert = new Map();
    for (const b of payoutData.earned) {
      const cur = byExpert.get(b.expert_id) || { gross: 0, paidOut: 0, jobs: 0 };
      cur.gross += b.service_fee_cents || 0;
      cur.jobs += 1;
      byExpert.set(b.expert_id, cur);
    }
    for (const p of payoutData.paid) {
      const cur = byExpert.get(p.expert_id) || { gross: 0, paidOut: 0, jobs: 0 };
      cur.paidOut += p.amount_cents || 0;
      byExpert.set(p.expert_id, cur);
    }
    const payouts = [];
    for (const [expertId, v] of byExpert) {
      const net = Math.round((v.gross * (100 - fee)) / 100);
      const owed = Math.max(0, net - v.paidOut);
      if (owed > 0) {
        const u = await getUserById(expertId);
        payouts.push({ expertId, name: u?.full_name || u?.username || expertId.slice(0, 8), jobs: v.jobs, owedCents: owed });
      }
    }
    res.json({ applications: apps, dispatch, openBookings: open, awaitingPayment: awaitingPay, faresNeeded: fares, payouts });
  });

  api.get('/experts', async (_req, res) => {
    res.json(await listExperts({ activeOnly: true }));
  });

  api.get('/audit', async (_req, res) => {
    res.json(await listStaffActions(100));
  });

  // Log an off-platform payment — full bot-side notification fidelity.
  api.post('/orders/:id/paid', async (req, res) => {
    const order = await getOrder(req.params.id);
    if (!order || order.status !== 'pending') return res.status(409).json({ error: 'order is not awaiting payment' });
    const ok = await confirmOrder({ bot: ctx?.bot }, order, { auto: false });
    res.json({ ok });
  });

  api.post('/bookings/:id/paid', async (req, res) => {
    const booking = await getBooking(req.params.id);
    if (!booking || booking.payment_status === 'paid') return res.status(409).json({ error: 'not awaiting payment' });
    const ok = await confirmBooking({ bot: ctx?.bot }, booking, { auto: false });
    res.json({ ok });
  });

  // Confirm a manual travel fare; customer gets the pay button.
  api.post('/bookings/:id/fare', async (req, res) => {
    const cents = manualSurchargeCents(String(req.body?.dollars ?? ''));
    if (cents === null) return res.status(400).json({ error: 'invalid amount' });
    const booking = await getBooking(req.params.id);
    if (!booking) return res.status(404).json({ error: 'not found' });
    const total = booking.service_fee_cents + cents;
    const updated = await setBookingSurcharge(booking.id, { surchargeCents: cents, source: 'manual', totalCents: total });
    if (!updated) return res.status(409).json({ error: 'could not set fare' });
    try {
      await ctx?.bot?.sendMessage(
        updated.customer_telegram_id,
        `✅ Travel fare confirmed: $${(cents / 100).toFixed(2)}. Total $${(total / 100).toFixed(2)}.`,
        { reply_markup: { inline_keyboard: [[{ text: `Pay $${(total / 100).toFixed(2)}`, callback_data: `book:pay:${booking.id}` }]] } }
      );
    } catch { /* ignore */ }
    res.json({ ok: true });
  });

  // Assign a Block Expert to an open booking.
  api.post('/bookings/:id/assign', async (req, res) => {
    const expertId = String(req.body?.expertId || '');
    const booking = await getBooking(req.params.id);
    if (!booking || booking.status !== 'awaiting_acceptance') return res.status(409).json({ error: 'booking is not open' });
    const accepted = await acceptOpenBooking(booking.id, expertId);
    if (!accepted) return res.status(409).json({ error: 'no longer open' });
    const expert = await getUserById(expertId);
    try {
      if (expert) await ctx?.bot?.sendMessage(expert.telegram_id, `📋 You’ve been assigned a job — check /builder → My jobs.`);
      await ctx?.bot?.sendMessage(accepted.customer_telegram_id, `🎉 A Block Expert was assigned! Total $${((accepted.total_cents || 0) / 100).toFixed(2)}.`, {
        reply_markup: { inline_keyboard: [[{ text: 'Pay now', callback_data: `book:pay:${booking.id}` }]] },
      });
    } catch { /* ignore */ }
    res.json({ ok: true });
  });

  // Record a payout transfer (money moves outside; this is the ledger).
  api.post('/payouts/:expertId', async (req, res) => {
    const amount = Number.parseInt(req.body?.amountCents, 10);
    if (!Number.isInteger(amount) || amount <= 0) return res.status(400).json({ error: 'invalid amount' });
    await recordPayout(req.params.expertId, amount, 'dashboard');
    await logStaffAction(null, 'dashboard', 'payout.record', req.params.expertId, String(amount));
    const u = await getUserById(req.params.expertId);
    try {
      if (u) await ctx?.bot?.sendMessage(u.telegram_id, `💸 You’ve been paid $${(amount / 100).toFixed(2)} — thanks for building with us!`);
    } catch { /* ignore */ }
    res.json({ ok: true });
  });

  // User management: role + active (dashboard token = owner-level).
  api.post('/users/:telegramId/role', async (req, res) => {
    const role = String(req.body?.role || '');
    if (!['customer', 'expert', 'block_manager', 'store_manager', 'support', 'administrator'].includes(role))
      return res.status(400).json({ error: 'invalid role' });
    const updated = await setRole(Number(req.params.telegramId), role);
    if (!updated) return res.status(404).json({ error: 'user not found' });
    await logStaffAction(null, 'dashboard', 'role.set', String(updated.telegram_id), role);
    refreshChatCommands(ctx?.bot, updated.telegram_id, { isExpert: role === 'expert', isStaffMember: isStaff(role) });
    try {
      await ctx?.bot?.sendMessage(updated.telegram_id, `🎖️ Your role is now ${ROLE_LABELS[role]}.`);
    } catch { /* ignore */ }
    res.json({ ok: true });
  });

  api.post('/users/:telegramId/active', async (req, res) => {
    const updated = await setActive(Number(req.params.telegramId), Boolean(req.body?.active));
    if (!updated) return res.status(404).json({ error: 'user not found' });
    res.json({ ok: true, active: updated.active });
  });

  // Inventory management.
  api.get('/inventory', async (_req, res) => {
    res.json(await listInventory());
  });
  api.post('/inventory/:sku/stock', async (req, res) => {
    const qty = Number.parseInt(req.body?.qty, 10);
    if (!Number.isInteger(qty) || qty < 0) return res.status(400).json({ error: 'invalid qty' });
    const updated = await setStock(req.params.sku, qty);
    res.json(updated ? { ok: true, stock: updated.stock_qty } : { ok: false });
  });
  api.post('/inventory/:sku/price', async (req, res) => {
    const dollars = Number.parseFloat(req.body?.dollars);
    if (Number.isNaN(dollars) || dollars < 0) return res.status(400).json({ error: 'invalid price' });
    const updated = await setProductPrice(req.params.sku, { unitPriceCents: Math.round(dollars * 100) });
    res.json(updated ? { ok: true } : { ok: false });
  });
  api.post('/inventory/:sku/min', async (req, res) => {
    const min = Number.parseInt(req.body?.min, 10);
    if (!Number.isInteger(min) || min < 1) return res.status(400).json({ error: 'minimum must be 1 or more' });
    const { data } = await supabase.from('inventory').update({ min_qty: min }).eq('sku', req.params.sku).select('min_qty').maybeSingle();
    res.json(data ? { ok: true, min: data.min_qty } : { ok: false });
  });
  api.post('/inventory/:sku/floor', async (req, res) => {
    const floor = Number.parseInt(req.body?.floor, 10);
    if (!Number.isInteger(floor) || floor < 0) return res.status(400).json({ error: 'invalid floor' });
    const { data } = await supabase.from('inventory').update({ reorder_floor: floor }).eq('sku', req.params.sku).select('reorder_floor').maybeSingle();
    res.json(data ? { ok: true, floor: data.reorder_floor } : { ok: false });
  });

  router.use('/admin/api', api);


  return router;
}
