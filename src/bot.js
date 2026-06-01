import TelegramBot from 'node-telegram-bot-api';
import { config, isAdminId } from './config.js';
import { upsertUser, getUserByTelegramId } from './supabase.js';
import { mainMenu } from './lib/keyboards.js';

import * as shop from './flows/shop.js';
import * as booking from './flows/booking.js';
import * as expert from './flows/expert.js';
import * as admin from './flows/admin.js';
import * as review from './flows/review.js';
import * as payments from './flows/payments.js';

export function createBot() {
  const bot = new TelegramBot(config.telegram.token, { polling: true });
  const sessions = new Map(); // chatId -> { flow, step, data }
  const ctx = { bot, sessions };

  const sliceAfter = (data, prefix) => data.slice(prefix.length);

  async function sendMainMenu(chatId, telegramId) {
    const user = await getUserByTelegramId(telegramId);
    await bot.sendMessage(
      chatId,
      '🧱 *Heaux SF — LEGO* 🧱\n\nBuy red LEGOs or book a LEGO expert to set them up.',
      {
        parse_mode: 'Markdown',
        ...mainMenu({
          isExpert: user?.role === 'expert' || user?.role === 'admin',
          isAdmin: isAdminId(telegramId),
        }),
      }
    );
  }

  // ── Commands ───────────────────────────────────────────────────────
  bot.onText(/^\/start/, async (msg) => {
    const from = msg.from;
    await upsertUser({
      telegramId: from.id,
      username: from.username,
      fullName: [from.first_name, from.last_name].filter(Boolean).join(' '),
    });
    sessions.delete(msg.chat.id);
    await sendMainMenu(msg.chat.id, from.id);
  });

  bot.onText(/^\/shop/, (msg) => shop.startShop(ctx, msg.chat.id));
  bot.onText(/^\/book/, (msg) => booking.startBooking(ctx, msg.chat.id));
  bot.onText(/^\/expert/, (msg) => expert.listJobs(ctx, msg.chat.id, msg.from.id));
  bot.onText(/^\/admin/, (msg) => admin.showMenu(ctx, msg.chat.id, msg.from.id));

  bot.onText(/^\/skip/, async (msg) => {
    const s = sessions.get(msg.chat.id);
    if (s?.flow === 'review' && s.step === 'awaiting_comment') {
      sessions.delete(msg.chat.id);
      await bot.sendMessage(msg.chat.id, '👍 No comment added. Thanks!');
    }
  });

  // ── Free-text (multi-step flow input) ────────────────────────────────
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const s = sessions.get(chatId);

    // Shared-contact replies (phone number) have no text.
    if (msg.contact && s?.flow === 'shop' && s.step === 'awaiting_phone') {
      try {
        await shop.receivePhone(ctx, chatId, telegramId, msg.contact.phone_number, msg.from.username);
      } catch (err) {
        console.error('contact handler error:', err);
      }
      return;
    }
    if (!msg.text || msg.text.startsWith('/')) return; // commands handled above
    if (!s) return;

    try {
      if (s.flow === 'shop' && s.step === 'awaiting_qty') {
        await shop.chooseQty(ctx, chatId, Number.parseInt(msg.text.trim(), 10));
      } else if (s.flow === 'shop' && s.step === 'awaiting_delivery_address') {
        await shop.receiveDeliveryAddress(ctx, chatId, telegramId, msg.text.trim());
      } else if (s.flow === 'shop' && s.step === 'awaiting_phone') {
        await shop.receivePhone(ctx, chatId, telegramId, msg.text.trim(), msg.from.username);
      } else if (s.flow === 'book' && s.step === 'awaiting_address') {
        await booking.receiveAddress(ctx, chatId, telegramId, msg.text.trim());
      } else if (s.flow === 'admin' && s.step === 'awaiting_add_expert') {
        await admin.doAddExpert(ctx, chatId, msg.text);
      } else if (s.flow === 'admin' && s.step === 'awaiting_remove') {
        await admin.doRemove(ctx, chatId, msg.text);
      } else if (s.flow === 'admin' && s.step === 'awaiting_fare') {
        await admin.doSetFare(ctx, chatId, msg.text);
      } else if (s.flow === 'admin' && s.step === 'awaiting_stock') {
        await admin.doSetStock(ctx, chatId, msg.text);
      } else if (s.flow === 'expert' && s.step === 'awaiting_builder_address') {
        await expert.doSetAddress(ctx, chatId, telegramId, msg.text.trim());
      } else if (s.flow === 'review' && s.step === 'awaiting_comment') {
        await review.addComment(ctx, chatId, telegramId, msg.text.trim());
      }
    } catch (err) {
      console.error('message handler error:', err);
      await bot.sendMessage(chatId, '⚠️ Something went wrong. Tap /start to try again.');
    }
  });

  // ── Inline buttons ───────────────────────────────────────────────────
  bot.on('callback_query', async (q) => {
    const chatId = q.message?.chat?.id;
    const telegramId = q.from.id;
    const data = q.data || '';
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
      // Booking
      else if (data === 'book:start') await booking.startBooking(ctx, chatId);
      else if (data.startsWith('book:day:'))
        await booking.pickDay(ctx, chatId, sliceAfter(data, 'book:day:'));
      else if (data.startsWith('book:hour:'))
        await booking.pickHour(ctx, chatId, sliceAfter(data, 'book:hour:'));
      else if (data.startsWith('book:pay:'))
        await booking.payBooking(ctx, chatId, telegramId, sliceAfter(data, 'book:pay:'));
      else if (data === 'book:cancel') await booking.cancelBooking(ctx, chatId);
      // Payments (method selection / crypto / admin confirm)
      else if (data.startsWith('pm:')) {
        const p = sliceAfter(data, 'pm:').split(':'); // crypto-only (btc/ltc)
        if (p[0] === 'o') await payments.payOrderCrypto(ctx, chatId, telegramId, p[1], p[2]); // p[2]=orderId
        else if (p[0] === 'b') await payments.payBookingCrypto(ctx, chatId, telegramId, p[1], p[2]);
        else if (p[0] === 'sent') await payments.customerSent(ctx, chatId, p[1], p[2]);
        else if (p[0] === 'ok') await payments.adminConfirm(ctx, chatId, telegramId, p[1], p[2]);
        else if (p[0] === 'disp') await payments.adminDispatch(ctx, chatId, telegramId, p[1]);
      }
      // Expert
      else if (data === 'exp:list') await expert.listJobs(ctx, chatId, telegramId);
      else if (data === 'exp:addr') await expert.promptSetAddress(ctx, chatId, telegramId);
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
      else if (data === 'adm:addexpert') await admin.promptAddExpert(ctx, chatId, telegramId);
      else if (data === 'adm:remove') await admin.promptRemove(ctx, chatId, telegramId);
      else if (data === 'adm:bookings') await admin.showBookings(ctx, chatId, telegramId);
      else if (data === 'adm:inv') await admin.showInventory(ctx, chatId, telegramId);
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
      console.error('callback handler error:', err);
    } finally {
      bot.answerCallbackQuery(q.id).catch(() => {});
    }
  });

  bot.on('polling_error', (err) => console.error('polling_error:', err.message));

  return { bot, ctx };
}
