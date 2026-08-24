import TelegramBot from 'node-telegram-bot-api';
import { config, isAdminId } from './config.js';
import { upsertUser, getUserByTelegramId, deleteUserData } from './supabase.js';
import { mainMenu } from './lib/keyboards.js';
import { effectiveRole, isStaff } from './lib/roles.js';
import { refreshChatCommands } from './lib/commands.js';
import { log, reportError } from './lib/log.js';
import { SessionStore } from './lib/sessions.js';

import * as shop from './flows/shop.js';
import * as booking from './flows/booking.js';
import * as expert from './flows/expert.js';
import * as admin from './flows/admin.js';
import * as review from './flows/review.js';
import * as payments from './flows/payments.js';
import * as account from './flows/account.js';
import * as wallet from './flows/wallet.js';
import * as apply from './flows/apply.js';
import * as relay from './flows/relay.js';
import * as testmode from './flows/testmode.js';

// Simple per-user rate limiter (#23): max N actions per sliding window.
function makeRateLimiter({ max, windowMs }) {
  const hits = new Map(); // userId -> [timestamps]
  return (userId) => {
    const now = Date.now();
    const recent = (hits.get(userId) || []).filter((t) => now - t < windowMs);
    recent.push(now);
    hits.set(userId, recent);
    return recent.length <= max;
  };
}

export function createBot() {
  const bot = new TelegramBot(config.telegram.token, { polling: true });
  const sessions = new SessionStore(config.session.ttlMs); // persisted + idle-TTL
  sessions.hydrate(); // floating: rehydrate in-progress flows after a restart
  setInterval(() => sessions.sweep(), 5 * 60 * 1000);
  const allow = makeRateLimiter(config.rateLimit);
  const ctx = { bot, sessions };

  // Register the in-app slash-command menu (the "/" button). Best-effort.
  bot
    .setMyCommands([
      { command: 'shop', description: 'Browse & order 3D-printed parts' },
      { command: 'book', description: 'Book a Block Expert (on-site build help)' },
      { command: 'wallet', description: 'Add funds & check your balance' },
      { command: 'orders', description: 'Your recent orders & bookings' },
      { command: 'help', description: 'How this bot works' },
    ])
    .catch((err) => console.error('setMyCommands failed:', err.message));

  const sliceAfter = (data, prefix) => data.slice(prefix.length);

  async function sendMainMenu(chatId, telegramId) {
    const user = await getUserByTelegramId(telegramId);
    // Keep the "/" menu in sync with what this person can actually do.
    refreshChatCommands(bot, chatId, {
      isExpert: user?.role === 'expert' || user?.role === 'admin',
      isStaffMember: isAdminId(telegramId) || isStaff(effectiveRole(user)),
    });
    await bot.sendMessage(
      chatId,
      '🧱 *SF Brick Company* 🧱\n\n' +
        'Welcome! Here’s what you can do:\n\n' +
        '🛒 *Shop* — custom 3D-printed accessories & upgrades for building-block brands, shipped to you.\n' +
        '🛠️ *Book a Block Expert* — a vetted local builder comes to you in SF to help build, hands-on.\n' +
        '💰 *Wallet* — load credit once, then check out in a tap.\n\n' +
        'Pay in crypto or from your wallet. Tap a button below to start.',
      {
        parse_mode: 'Markdown',
        ...mainMenu({
          isExpert: user?.role === 'expert' || user?.role === 'admin',
          isAdmin: isAdminId(telegramId) || isStaff(effectiveRole(user)),
        }),
      }
    );
  }

  // ── Commands ───────────────────────────────────────────────────────
  bot.onText(/^\/start(?:\s+(\S+))?/, async (msg, match) => {
    const from = msg.from;
    await upsertUser({
      telegramId: from.id,
      username: from.username,
      fullName: [from.first_name, from.last_name].filter(Boolean).join(' '),
    });
    sessions.delete(msg.chat.id);
    // Deep-link payload: t.me/<bot>?start=shop|book|wallet jumps straight in.
    const payload = (match?.[1] || '').toLowerCase();
    if (payload === 'shop') return shop.startShop(ctx, msg.chat.id);
    if (payload === 'book') return booking.startBooking(ctx, msg.chat.id);
    if (payload === 'wallet') return wallet.showWallet(ctx, msg.chat.id, from.id);
    if (payload === 'apply') return apply.startApply(ctx, msg.chat.id, msg.from.id);
    await sendMainMenu(msg.chat.id, from.id);
  });

  bot.onText(/^\/shop/, (msg) => shop.startShop(ctx, msg.chat.id));
  bot.onText(/^\/book/, (msg) => booking.startBooking(ctx, msg.chat.id));
  bot.onText(/^\/help/, (msg) => account.showHelp(ctx, msg.chat.id, msg.from.id));
  bot.onText(/^\/orders/, (msg) => account.showMyOrders(ctx, msg.chat.id, msg.from.id));
  bot.onText(/^\/(wallet|balance)/, (msg) => wallet.showWallet(ctx, msg.chat.id, msg.from.id));
  bot.onText(/^\/apply/, (msg) => apply.startApply(ctx, msg.chat.id, msg.from.id));
  bot.onText(/^\/forgetme/, (msg) =>
    bot.sendMessage(
      msg.chat.id,
      '⚠️ This permanently deletes your account, orders, bookings, and wallet balance. It cannot be undone.',
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🗑️ Yes, delete everything', callback_data: 'acct:forget' }],
            [{ text: 'Cancel', callback_data: 'acct:forgetno' }],
          ],
        },
      }
    )
  );
  // Builder portal — /builder (and /expert alias). upsertUser applies any
  // pending @handle invite, promoting the user to builder on first visit.
  const openBuilderPortal = async (msg) => {
    await upsertUser({
      telegramId: msg.from.id,
      username: msg.from.username,
      fullName: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' '),
    });
    await expert.builderPortal(ctx, msg.chat.id, msg.from.id);
  };
  bot.onText(/^\/builder/, openBuilderPortal);
  bot.onText(/^\/expert/, openBuilderPortal);
  // Owner control panel — /owner (and /admin kept as a hidden alias).
  bot.onText(/^\/(owner|admin)/, (msg) => admin.showMenu(ctx, msg.chat.id, msg.from.id));

  bot.onText(/^\/skip/, async (msg) => {
    const s = sessions.get(msg.chat.id);
    if (s?.flow === 'review' && s.step === 'awaiting_comment') {
      sessions.delete(msg.chat.id);
      await bot.sendMessage(msg.chat.id, '👍 No comment added. Thanks!');
    }
  });

  // ── Free-text (multi-step flow input) ────────────────────────────────
  bot.on('message', async (msg) => {
    pollHealthy(); // any inbound message proves polling works (#52)
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    if (!allow(telegramId)) return; // rate limit (#23)
    const s = sessions.get(chatId);

    // Shared-contact replies (phone number) have no text.
    if (msg.contact && s?.flow === 'shop' && s.step === 'awaiting_phone') {
      try {
        await shop.receivePhone(ctx, chatId, telegramId, msg.contact.phone_number, msg.from.username);
      } catch (err) {
        await reportError(ctx, 'contact handler', err);
      }
      return;
    }
    if (msg.contact && s?.flow === 'apply' && s.step === 'phone') {
      try {
        await apply.receivePhone(ctx, chatId, msg.contact.phone_number);
      } catch (err) {
        await reportError(ctx, 'contact handler', err);
      }
      return;
    }
    if (!msg.text || msg.text.startsWith('/')) return; // commands handled above
    if (!s) return;

    try {
      if (s.flow === 'shop' && s.step === 'awaiting_qty') {
        await shop.chooseQty(ctx, chatId, Number.parseInt(msg.text.trim(), 10));
      } else if (s.flow === 'shop' && s.step === 'awaiting_street') {
        await shop.receiveStreet(ctx, chatId, msg.text.trim());
      } else if (s.flow === 'shop' && s.step === 'awaiting_city') {
        await shop.receiveCity(ctx, chatId, msg.text.trim());
      } else if (s.flow === 'shop' && s.step === 'awaiting_zip') {
        await shop.receiveZip(ctx, chatId, msg.text.trim());
      } else if (s.flow === 'shop' && s.step === 'awaiting_phone') {
        await shop.receivePhone(ctx, chatId, telegramId, msg.text.trim(), msg.from.username);
      } else if (s.flow === 'shop' && s.step === 'awaiting_note') {
        await shop.receiveNote(ctx, chatId, telegramId, msg.text.trim());
      } else if (s.flow === 'book' && s.step === 'awaiting_street') {
        await booking.receiveStreet(ctx, chatId, msg.text.trim());
      } else if (s.flow === 'book' && s.step === 'awaiting_city') {
        await booking.receiveCity(ctx, chatId, msg.text.trim());
      } else if (s.flow === 'book' && s.step === 'awaiting_zip') {
        await booking.receiveZip(ctx, chatId, telegramId, msg.text.trim());
      } else if (s.flow === 'admin' && s.step === 'awaiting_add_expert') {
        await admin.doAddExpert(ctx, chatId, msg.text);
      } else if (s.flow === 'admin' && s.step === 'awaiting_remove') {
        await admin.doRemove(ctx, chatId, msg.text);
      } else if (s.flow === 'admin' && s.step === 'awaiting_fare') {
        await admin.doSetFare(ctx, chatId, msg.text);
      } else if (s.flow === 'admin' && s.step === 'awaiting_stock') {
        await admin.doSetStock(ctx, chatId, msg.text);
      } else if (s.flow === 'admin' && s.step === 'awaiting_broadcast') {
        await admin.doBroadcast(ctx, chatId, msg.text);
      } else if (s.flow === 'admin' && s.step === 'awaiting_find_order') {
        await admin.doFindOrder(ctx, chatId, msg.text);
      } else if (s.flow === 'admin' && s.step === 'awaiting_refund_txid') {
        await admin.doRefund(ctx, chatId, msg.text);
      } else if (s.flow === 'admin' && s.step === 'awaiting_fee') {
        await admin.doSetFee(ctx, chatId, msg.text);
      } else if (s.flow === 'admin' && s.step === 'awaiting_price') {
        await admin.doSetPrice(ctx, chatId, msg.text);
      } else if (s.flow === 'admin' && s.step === 'awaiting_add_sku') {
        await admin.doAddSku(ctx, chatId, msg.text);
      } else if (s.flow === 'expert' && s.step === 'awaiting_builder_address') {
        await expert.doSetAddress(ctx, chatId, telegramId, msg.text.trim());
      } else if (s.flow === 'expert' && s.step === 'awaiting_rate') {
        await expert.doSetRate(ctx, chatId, telegramId, msg.text.trim());
      } else if (s.flow === 'review' && s.step === 'awaiting_comment') {
        await review.addComment(ctx, chatId, telegramId, msg.text.trim());
      } else if (s.flow === 'wallet' && s.step === 'awaiting_amount') {
        await wallet.receiveCustomAmount(ctx, chatId, msg.text.trim());
      } else if (s.flow === 'promo' && s.step === 'awaiting_code') {
        await payments.applyPromo(ctx, chatId, msg.text.trim());
      } else if (s.flow === 'apply' && s.step === 'name') {
        await apply.receiveName(ctx, chatId, msg.text.trim());
      } else if (s.flow === 'apply' && s.step === 'phone') {
        await apply.receivePhone(ctx, chatId, msg.text.trim());
      } else if (s.flow === 'apply' && s.step === 'hours') {
        await apply.receiveHours(ctx, chatId, msg.text.trim());
      } else if (s.flow === 'apply' && s.step === 'rate') {
        await apply.receiveRate(ctx, chatId, msg.text.trim());
      } else if (s.flow === 'apply' && s.step === 'address') {
        await apply.receiveAddress(ctx, chatId, telegramId, msg.from.username, msg.text.trim());
      } else if (s.flow === 'relay' && s.step === 'messaging') {
        await relay.relayMessage(ctx, chatId, telegramId, msg.text.trim());
      } else if (s.flow === 'admin' && s.step === 'awaiting_add_promo') {
        await admin.doAddPromo(ctx, chatId, msg.text);
      } else if (s.flow === 'admin' && s.step === 'awaiting_exp_rate') {
        await admin.doExpertRate(ctx, chatId, msg.text);
      } else if (s.flow === 'admin' && s.step === 'awaiting_exp_addr') {
        await admin.doExpertAddress(ctx, chatId, msg.text);
      } else if (s.flow === 'admin' && s.step === 'awaiting_role_user') {
        await admin.doPickRoleUser(ctx, chatId, telegramId, msg.text);
      }
    } catch (err) {
      await reportError(ctx, 'message handler', err);
      await bot.sendMessage(chatId, '⚠️ Something went wrong. Tap /start to try again.');
    }
  });

  // ── Inline buttons ───────────────────────────────────────────────────
  bot.on('callback_query', async (q) => {
    pollHealthy();
    const chatId = q.message?.chat?.id;
    const telegramId = q.from.id;
    const data = q.data || '';
    const messageId = q.message?.message_id;
    if (!allow(telegramId)) {
      bot.answerCallbackQuery(q.id, { text: 'Slow down a moment…' }).catch(() => {});
      return;
    }
    try {
      // Shop
      if (data === 'shop:start') await shop.startShop(ctx, chatId);
      else if (data.startsWith('shop:p:')) await shop.chooseProduct(ctx, chatId, sliceAfter(data, 'shop:p:'));
      else if (data.startsWith('shop:pack:')) {
        const [sku, qty] = sliceAfter(data, 'shop:pack:').split(':');
        await shop.choosePack(ctx, chatId, sku, Number.parseInt(qty, 10));
      } else if (data === 'shop:qty:custom') await shop.promptCustomQty(ctx, chatId);
      else if (data.startsWith('shop:qty:'))
        await shop.chooseQty(ctx, chatId, Number.parseInt(sliceAfter(data, 'shop:qty:'), 10));
      else if (data === 'shop:cart') await shop.showCart(ctx, chatId);
      else if (data === 'shop:checkout') await shop.checkout(ctx, chatId);
      else if (data === 'shop:clear') await shop.clearCart(ctx, chatId);
      else if (data === 'shop:upsell') await shop.startUpsell(ctx, chatId, 20);
      else if (data === 'shop:addadmin') await booking.startBooking(ctx, chatId);
      else if (data === 'shop:lastaddr') await shop.useLastAddress(ctx, chatId);
      else if (data === 'shop:newaddr') await shop.promptNewAddress(ctx, chatId);
      else if (data === 'shop:noteskip') await shop.skipNote(ctx, chatId, telegramId);
      // Booking
      else if (data === 'book:start') await booking.startBooking(ctx, chatId);
      else if (data.startsWith('book:day:'))
        await booking.pickDay(ctx, chatId, sliceAfter(data, 'book:day:'));
      else if (data.startsWith('book:hour:'))
        await booking.pickHour(ctx, chatId, sliceAfter(data, 'book:hour:'));
      else if (data.startsWith('book:rs:'))
        await booking.doReschedule(ctx, chatId, telegramId, sliceAfter(data, 'book:rs:'));
      else if (data.startsWith('book:admin:'))
        await booking.chooseAdmin(ctx, chatId, sliceAfter(data, 'book:admin:'));
      else if (data.startsWith('book:pay:'))
        await booking.payBooking(ctx, chatId, telegramId, sliceAfter(data, 'book:pay:'));
      else if (data === 'book:travel:ride') await booking.chooseTravel(ctx, chatId, true);
      else if (data === 'book:travel:flat') await booking.chooseTravel(ctx, chatId, false);
      else if (data === 'book:reqok') await booking.confirmRequest(ctx, chatId, telegramId);
      else if (data === 'book:cancel') await booking.cancelBooking(ctx, chatId);
      // Payments (method selection / crypto / admin confirm)
      else if (data.startsWith('pm:')) {
        const p = sliceAfter(data, 'pm:').split(':'); // crypto-only (btc/ltc)
        if (p[0] === 'o') await payments.payOrderCrypto(ctx, chatId, telegramId, p[1], p[2]); // p[2]=orderId
        else if (p[0] === 'b') await payments.payBookingCrypto(ctx, chatId, telegramId, p[1], p[2]);
        else if (p[0] === 'bal') {
          // pm:bal:<kind>:<ref> — pay from prepaid wallet balance
          if (p[1] === 'o') await payments.payOrderFromBalance(ctx, chatId, telegramId, p[2]);
          else if (p[1] === 'b') await payments.payBookingFromBalance(ctx, chatId, telegramId, p[2]);
        } else if (p[0] === 're') {
          // pm:re:<kind>:<coin>:<ref> — re-quote a fresh address/rate
          if (p[1] === 'o') await payments.payOrderCrypto(ctx, chatId, telegramId, p[2], p[3], { refresh: true });
          else if (p[1] === 'b') await payments.payBookingCrypto(ctx, chatId, telegramId, p[2], p[3], { refresh: true });
        } else if (p[0] === 'agree') await payments.acceptWaiver(ctx, chatId, telegramId, p[1], p[2]);
        else if (p[0] === 'agreeno') await payments.declineWaiver(ctx, chatId, p[1], p[2]);
        else if (p[0] === 'promo') await payments.promptPromo(ctx, chatId, p[1]); // p[1]=orderId
        else if (p[0] === 'sent') await payments.customerSent(ctx, chatId, p[1], p[2]);
        else if (p[0] === 'ok') await payments.adminConfirm(ctx, chatId, telegramId, p[1], p[2]);
        else if (p[0] === 'disp') await payments.adminDispatch(ctx, chatId, telegramId, p[1]);
        else if (p[0] === 'deliv') await payments.adminDelivered(ctx, chatId, telegramId, p[1]);
      }
      // Wallet
      else if (data === 'wal:menu') await wallet.showWallet(ctx, chatId, telegramId);
      else if (data === 'wal:add') await wallet.startDeposit(ctx, chatId);
      else if (data === 'wal:stmt') await wallet.showStatement(ctx, chatId, telegramId);
      else if (data === 'wal:amt:custom') await wallet.promptCustomAmount(ctx, chatId);
      else if (data.startsWith('wal:amt:'))
        await wallet.chooseAmount(ctx, chatId, Number.parseInt(sliceAfter(data, 'wal:amt:'), 10));
      else if (data.startsWith('wal:coin:')) {
        const [coin, cents] = sliceAfter(data, 'wal:coin:').split(':');
        await wallet.payDeposit(ctx, chatId, telegramId, coin, Number.parseInt(cents, 10));
      }
      // Apply to be a Block Expert
      else if (data.startsWith('relay:')) {
        const parts = sliceAfter(data, 'relay:').split(':');
        // New: relay:<kind>:<role>:<ref>. Legacy buttons: relay:<role>:<ref> (booking).
        const [kind, role, ref] = parts.length === 3 ? parts : ['b', parts[0], parts[1]];
        await relay.startRelay(ctx, chatId, telegramId, kind, ref, role);
      }
      // Apply to be a Block Expert
      else if (data === 'apply:start') await apply.startApply(ctx, chatId, telegramId);
      else if (data.startsWith('apply:hrs:')) await apply.chooseHours(ctx, chatId, sliceAfter(data, 'apply:hrs:'));
      else if (data.startsWith('apply:rate:')) await apply.chooseRate(ctx, chatId, sliceAfter(data, 'apply:rate:'));
      else if (data === 'apply:agree') await apply.agreeAndSubmit(ctx, chatId, telegramId);
      else if (data === 'apply:cancel') await apply.cancelApply(ctx, chatId);
      // Account self-service
      else if (data === 'acct:orders') await account.showMyOrders(ctx, chatId, telegramId);
      else if (data.startsWith('acct:payo:'))
        await account.showOrderPayment(ctx, chatId, telegramId, sliceAfter(data, 'acct:payo:'));
      else if (data.startsWith('acct:payb:'))
        await account.showBookingPayment(ctx, chatId, telegramId, sliceAfter(data, 'acct:payb:'));
      else if (data.startsWith('acct:cano:'))
        await account.cancelMyOrder(ctx, chatId, telegramId, sliceAfter(data, 'acct:cano:'));
      else if (data.startsWith('acct:canb:'))
        await account.cancelMyBooking(ctx, chatId, telegramId, sliceAfter(data, 'acct:canb:'));
      else if (data.startsWith('acct:resb:'))
        await booking.startReschedule(ctx, chatId, telegramId, sliceAfter(data, 'acct:resb:'));
      else if (data === 'acct:forget') {
        await deleteUserData(telegramId);
        sessions.delete(chatId);
        await bot.sendMessage(chatId, '🗑️ Your data has been deleted. Take care!');
      } else if (data === 'acct:forgetno') {
        await bot.sendMessage(chatId, 'Cancelled — nothing was deleted.');
      }
      // Expert
      else if (data === 'exp:list') await expert.listJobs(ctx, chatId, telegramId);
      else if (data === 'exp:addr') await expert.promptSetAddress(ctx, chatId, telegramId);
      else if (data === 'exp:rate') await expert.promptSetRate(ctx, chatId, telegramId);
      else if (data === 'exp:avail') await expert.showAvailability(ctx, chatId, telegramId);
      else if (data.startsWith('exp:avpreset:'))
        await expert.applyAvailPreset(ctx, chatId, telegramId, sliceAfter(data, 'exp:avpreset:'), messageId);
      else if (data.startsWith('exp:av:')) {
        const [dow, blockKey] = sliceAfter(data, 'exp:av:').split(':');
        await expert.toggleAvailBlock(ctx, chatId, telegramId, Number.parseInt(dow, 10), blockKey, messageId);
      } else if (data === 'exp:avclear') await expert.clearAvailability(ctx, chatId, telegramId, messageId);
      else if (data === 'exp:avdone') await expert.doneAvailability(ctx, chatId, telegramId);
      else if (data === 'exp:off') await expert.showTimeOff(ctx, chatId, telegramId);
      else if (data.startsWith('exp:off:'))
        await expert.toggleTimeOff(ctx, chatId, telegramId, sliceAfter(data, 'exp:off:'), messageId);
      else if (data === 'exp:jobs') await expert.showMyJobs(ctx, chatId, telegramId);
      else if (data === 'exp:agreeyes') await expert.acceptBuilderAgreement(ctx, chatId, telegramId);
      else if (data === 'exp:agreeno') await expert.declineBuilderAgreement(ctx, chatId);
      else if (data.startsWith('exp:done:'))
        await expert.jobDone(ctx, chatId, telegramId, sliceAfter(data, 'exp:done:'));
      else if (data.startsWith('exp:cancel:'))
        await expert.cancelJob(ctx, chatId, telegramId, sliceAfter(data, 'exp:cancel:'));
      else if (data.startsWith('exp:acc:'))
        await expert.accept(ctx, chatId, telegramId, sliceAfter(data, 'exp:acc:'));
      else if (data.startsWith('exp:dec:'))
        await expert.decline(ctx, chatId, sliceAfter(data, 'exp:dec:'));
      // Review
      else if (data.startsWith('rev:rate:')) {
        const [id, n] = sliceAfter(data, 'rev:rate:').split(':');
        await review.rate(ctx, chatId, telegramId, id, Number.parseInt(n, 10));
      }
      // Admin
      else if (data === 'adm:menu') await admin.showMenu(ctx, chatId, telegramId);
      else if (data === 'adm:users') await admin.showUsers(ctx, chatId, telegramId);
      else if (data.startsWith('adm:cat:'))
        await admin.showCategory(ctx, chatId, telegramId, sliceAfter(data, 'adm:cat:'));
      else if (data === 'adm:repeat') await admin.showRepeatCustomers(ctx, chatId, telegramId);
      else if (data === 'adm:payouts') await admin.showPayouts(ctx, chatId, telegramId);
      else if (data.startsWith('adm:payout:')) {
        const [eid, cents] = sliceAfter(data, 'adm:payout:').split(':');
        await admin.doPayout(ctx, chatId, telegramId, eid, cents);
      } else if (data === 'adm:csv') await admin.exportCsv(ctx, chatId, telegramId);
      else if (data === 'adm:test:clean') await testmode.cleanDemoData(ctx, chatId, telegramId);
      else if (data === 'adm:test') await testmode.showTestMode(ctx, chatId, telegramId);
      else if (data === 'adm:test:cust') await testmode.setMode(ctx, chatId, telegramId, 'customer');
      else if (data === 'adm:test:build') await testmode.setMode(ctx, chatId, telegramId, 'expert');
      else if (data === 'adm:test:owner') await testmode.setMode(ctx, chatId, telegramId, 'admin');
      else if (data === 'adm:test:pay') await testmode.showSimPayments(ctx, chatId, telegramId);
      else if (data === 'adm:test:wallet') await testmode.topUpTestWallet(ctx, chatId, telegramId);
      else if (data.startsWith('adm:test:payo:'))
        await testmode.simulateOrderPay(ctx, chatId, telegramId, sliceAfter(data, 'adm:test:payo:'));
      else if (data.startsWith('adm:test:payb:'))
        await testmode.simulateBookingPay(ctx, chatId, telegramId, sliceAfter(data, 'adm:test:payb:'));
      else if (data === 'adm:addexpert') await admin.promptAddExpert(ctx, chatId, telegramId);
      else if (data === 'adm:experts') await admin.showExperts(ctx, chatId, telegramId);
      else if (data.startsWith('adm:exprate:'))
        await admin.promptExpertRate(ctx, chatId, telegramId, sliceAfter(data, 'adm:exprate:'));
      else if (data.startsWith('adm:expaddr:'))
        await admin.promptExpertAddress(ctx, chatId, telegramId, sliceAfter(data, 'adm:expaddr:'));
      else if (data.startsWith('adm:expsched:'))
        await admin.promptExpertSchedule(ctx, chatId, telegramId, sliceAfter(data, 'adm:expsched:'));
      else if (data.startsWith('adm:expav:')) {
        const [eid, preset] = sliceAfter(data, 'adm:expav:').split(':');
        await admin.setExpertSchedule(ctx, chatId, telegramId, eid, preset);
      } else if (data.startsWith('adm:exptoggle:'))
        await admin.toggleExpertActive(ctx, chatId, telegramId, sliceAfter(data, 'adm:exptoggle:'));
      else if (data.startsWith('adm:exp:'))
        await admin.showExpertCard(ctx, chatId, telegramId, sliceAfter(data, 'adm:exp:'));
      else if (data === 'adm:roles') await admin.showRoles(ctx, chatId, telegramId);
      else if (data.startsWith('adm:setrole:')) {
        const [tid, r] = sliceAfter(data, 'adm:setrole:').split(':');
        await admin.doSetRole(ctx, chatId, telegramId, tid, r);
      }
      else if (data === 'adm:remove') await admin.promptRemove(ctx, chatId, telegramId);
      else if (data === 'adm:bookings') await admin.showBookings(ctx, chatId, telegramId);
      else if (data === 'adm:orders') await admin.showOpenOrders(ctx, chatId, telegramId);
      else if (data === 'adm:broadcast') await admin.promptBroadcast(ctx, chatId, telegramId);
      else if (data === 'adm:find') await admin.promptFindOrder(ctx, chatId, telegramId);
      else if (data.startsWith('adm:refundo:'))
        await admin.promptRefund(ctx, chatId, telegramId, 'o', sliceAfter(data, 'adm:refundo:'));
      else if (data.startsWith('adm:refundb:'))
        await admin.promptRefund(ctx, chatId, telegramId, 'b', sliceAfter(data, 'adm:refundb:'));
      else if (data === 'adm:inv') await admin.showInventory(ctx, chatId, telegramId);
      else if (data === 'adm:fees') await admin.showFees(ctx, chatId, telegramId);
      else if (data.startsWith('adm:fee:'))
        await admin.promptSetFee(ctx, chatId, telegramId, sliceAfter(data, 'adm:fee:'));
      else if (data.startsWith('adm:price:'))
        await admin.promptSetPrice(ctx, chatId, telegramId, sliceAfter(data, 'adm:price:'));
      else if (data === 'adm:addsku') await admin.promptAddSku(ctx, chatId, telegramId);
      else if (data === 'adm:features') await admin.showFeatures(ctx, chatId, telegramId);
      else if (data.startsWith('adm:flag:'))
        await admin.toggleFlag(ctx, chatId, telegramId, sliceAfter(data, 'adm:flag:'), messageId);
      else if (data === 'adm:addpromo') await admin.promptAddPromo(ctx, chatId, telegramId);
      else if (data === 'adm:apps') await admin.showApplications(ctx, chatId, telegramId);
      else if (data.startsWith('adm:appok:'))
        await admin.approveApplication(ctx, chatId, telegramId, sliceAfter(data, 'adm:appok:'));
      else if (data.startsWith('adm:appno:'))
        await admin.rejectApplication(ctx, chatId, telegramId, sliceAfter(data, 'adm:appno:'));
      else if (data.startsWith('adm:stock:'))
        await admin.promptSetStock(ctx, chatId, telegramId, sliceAfter(data, 'adm:stock:'));
      else if (data.startsWith('adm:assignto:')) {
        const [bid, eid] = sliceAfter(data, 'adm:assignto:').split(':');
        await admin.assignExpert(ctx, chatId, telegramId, bid, eid);
      } else if (data.startsWith('adm:assign:'))
        await admin.chooseExpertForBooking(ctx, chatId, telegramId, sliceAfter(data, 'adm:assign:'));
      else if (data.startsWith('adm:fare:'))
        await admin.promptFare(ctx, chatId, telegramId, sliceAfter(data, 'adm:fare:'));
    } catch (err) {
      await reportError(ctx, 'callback handler', err);
    } finally {
      bot.answerCallbackQuery(q.id).catch(() => {});
    }
  });

  // Polling watchdog (#52): restart polling after repeated consecutive errors;
  // any successful inbound update resets the counter via pollHealthy().
  let pollErrors = 0;
  function pollHealthy() {
    pollErrors = 0;
  }
  bot.on('polling_error', (err) => {
    log.error(`polling_error: ${err.message}`);
    if (++pollErrors >= 5) {
      pollErrors = 0;
      log.warn('restarting polling after repeated errors');
      bot
        .stopPolling()
        .then(() => bot.startPolling())
        .catch((e) => log.error(`poll restart failed: ${e.message}`));
    }
  });

  return { bot, ctx };
}
