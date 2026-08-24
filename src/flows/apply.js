import { config } from '../config.js';
import {
  createApplication,
  getPendingApplication,
  getUserByTelegramId,
  setBuilderAgreement,
} from '../supabase.js';
import { geocode } from '../uber.js';
import { BUILDER_AGREEMENT } from './expert.js';
import { usd } from '../lib/format.js';

// Multi-step application to become a Block Expert. Anyone can apply, but every
// application is gated: it sits in `admin_applications` as `pending` until an
// owner explicitly approves it (adm:appok) — only then is the user promoted to
// the expert role. One pending application per person; already-approved Block
// Experts are pointed at their portal instead.
//
// Steps (6): name → phone (contact share) → hours (presets) → rate (buttons
// with net math) → address (geocode-validated) → agreement → submitted.
// The contractor agreement is accepted AS PART of the application, so an
// approved expert is immediately bookable — no post-approval chores.

const STEP = (n) => `_Step ${n} of 6_\n\n`;

export async function startApply(ctx, chatId, telegramId = chatId) {
  const user = await getUserByTelegramId(telegramId);
  if (user && (user.role === 'expert' || user.role === 'admin') && user.active) {
    await ctx.bot.sendMessage(
      chatId,
      '🧰 You’re already a Block Expert! Open your portal with /builder.'
    );
    return;
  }
  const pending = await getPendingApplication(telegramId);
  if (pending) {
    await ctx.bot.sendMessage(
      chatId,
      '⏳ Your Block Expert application is already *under review* — we’ll message you as soon as it’s approved or declined.',
      { parse_mode: 'Markdown' }
    );
    return;
  }
  const fee = config.pricing.platformFeePct;
  ctx.sessions.set(chatId, { flow: 'apply', step: 'name', data: {} });
  await ctx.bot.sendMessage(
    chatId,
    '🧰 *Apply to be a Block Expert*\n\n' +
      'Block Experts are vetted local builders who take *on-site, 1-hour sessions* helping customers build. Here’s what you’re signing up for:\n\n' +
      `• 💲 *You set your own rate* per session. We keep a *${fee}% platform fee*; you keep *${100 - fee}%*.\n` +
      '• 🗓️ *You set your hours* — customers can only book you when you’re available, and you can block time off anytime.\n' +
      '• 📍 You travel to the customer (they cover the ride or a flat travel fee).\n' +
      '• 💬 You coordinate *through the bot* — customer contact is shared only after they pay, and off-platform bookings aren’t allowed.\n' +
      '• 🧱 You’re an *independent contractor*, not an employee, and you assume the normal risks of on-site work.\n\n' +
      `${STEP(1)}First — what’s your *full name*?`,
    { parse_mode: 'Markdown', reply_markup: { force_reply: true, input_field_placeholder: 'Jane Builder' } }
  );
}

export async function receiveName(ctx, chatId, name) {
  const s = ctx.sessions.get(chatId);
  if (s?.flow !== 'apply' || s.step !== 'name') return;
  ctx.sessions.set(chatId, { ...s, step: 'phone', data: { ...s.data, name } });
  await ctx.bot.sendMessage(
    chatId,
    `${STEP(2)}What’s your *phone number*? Tap the button to share it, or type it.\n` +
      '_(Kept private — day-to-day coordination stays in Telegram; only company Administrators can see it.)_',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        keyboard: [[{ text: '📱 Share my number', request_contact: true }]],
        one_time_keyboard: true,
        resize_keyboard: true,
      },
    }
  );
}

export async function receivePhone(ctx, chatId, phone) {
  const s = ctx.sessions.get(chatId);
  if (s?.flow !== 'apply' || s.step !== 'phone') return;
  const digits = String(phone).replace(/[^0-9]/g, '');
  if (digits.length < 7) {
    await ctx.bot.sendMessage(chatId, 'That doesn’t look like a phone number — try again, or tap “📱 Share my number”.');
    return;
  }
  ctx.sessions.set(chatId, { ...s, step: 'hours', data: { ...s.data, phone: String(phone).trim() } });
  await ctx.bot.sendMessage(
    chatId,
    `${STEP(3)}What *hours* would you like to operate? Tap one (you can fine-tune later), or type your own:`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🌤️ Weekdays 9am–5pm', callback_data: 'apply:hrs:Weekdays 9am-5pm' }],
          [{ text: '🌙 Evenings 5–9pm every day', callback_data: 'apply:hrs:Every day 5pm-9pm' }],
          [{ text: '🎉 Weekends 9am–9pm', callback_data: 'apply:hrs:Weekends 9am-9pm' }],
          [{ text: '⚡ Every day 9am–9pm', callback_data: 'apply:hrs:Every day 9am-9pm' }],
        ],
      },
    }
  );
}

// Preset hours button tapped during the application.
export async function chooseHours(ctx, chatId, label) {
  const s = ctx.sessions.get(chatId);
  if (s?.flow !== 'apply' || s.step !== 'hours') return;
  await receiveHours(ctx, chatId, label);
}

function rateKeyboard() {
  const fee = config.pricing.platformFeePct;
  const net = (cents) => usd(Math.round((cents * (100 - fee)) / 100));
  const opt = (cents) => ({
    text: `${usd(cents)} → you keep ${net(cents)}`,
    callback_data: `apply:rate:${cents}`,
  });
  return {
    inline_keyboard: [
      [opt(3500)],
      [opt(4500)],
      [opt(6000)],
      [{ text: '✍️ Another amount', callback_data: 'apply:rate:custom' }],
    ],
  };
}

export async function receiveHours(ctx, chatId, hours) {
  const s = ctx.sessions.get(chatId);
  if (s?.flow !== 'apply' || s.step !== 'hours') return;
  ctx.sessions.set(chatId, { ...s, step: 'rate', data: { ...s.data, hours } });
  const fee = config.pricing.platformFeePct;
  await ctx.bot.sendMessage(
    chatId,
    `${STEP(4)}How much do you *charge* per 1-hour session? ` +
      `(We take a ${fee}% platform fee — each option shows what lands in your pocket.)`,
    { parse_mode: 'Markdown', reply_markup: rateKeyboard() }
  );
}

// Rate button tapped ("apply:rate:4500" or "apply:rate:custom").
export async function chooseRate(ctx, chatId, value) {
  const s = ctx.sessions.get(chatId);
  if (s?.flow !== 'apply' || s.step !== 'rate') return;
  if (value === 'custom') {
    await ctx.bot.sendMessage(chatId, 'Type your price in dollars (e.g. 42):', {
      reply_markup: { force_reply: true, input_field_placeholder: '42' },
    });
    return;
  }
  const cents = Number.parseInt(value, 10);
  if (!Number.isInteger(cents) || cents <= 0) return;
  await receiveRate(ctx, chatId, String(cents / 100));
}

export async function receiveRate(ctx, chatId, rate) {
  const s = ctx.sessions.get(chatId);
  if (s?.flow !== 'apply' || s.step !== 'rate') return;
  ctx.sessions.set(chatId, { ...s, step: 'address', data: { ...s.data, rate } });
  await ctx.bot.sendMessage(
    chatId,
    `${STEP(5)}Where are you *usually located*? Give the street address an Uber would pick you up from.`,
    {
      parse_mode: 'Markdown',
      reply_markup: { force_reply: true, input_field_placeholder: '123 Main St, San Francisco, CA 94110' },
    }
  );
}

export async function receiveAddress(ctx, chatId, telegramId, username, baseAddress) {
  const s = ctx.sessions.get(chatId);
  if (s?.flow !== 'apply' || s.step !== 'address') return;
  // Geocode check: an unmappable base means every future job falls into the
  // manual-fare path. One nudge to fix it, then accept whatever they give.
  if (!s.data.addressRetried) {
    const pin = await geocode(baseAddress);
    if (!pin) {
      ctx.sessions.set(chatId, { ...s, data: { ...s.data, addressRetried: true } });
      await ctx.bot.sendMessage(
        chatId,
        '🗺️ We couldn’t pin that on a map. A *full street address* (number, street, city) prices your travel automatically — one more try?',
        { parse_mode: 'Markdown', reply_markup: { force_reply: true, input_field_placeholder: '123 Main St, San Francisco, CA 94110' } }
      );
      return;
    }
  }
  ctx.sessions.set(chatId, {
    ...s,
    step: 'agreement',
    data: { ...s.data, baseAddress, telegramId, username: username || null },
  });
  await ctx.bot.sendMessage(chatId, `${STEP(6)}Last step — the agreement:`, { parse_mode: 'Markdown' });
  await ctx.bot.sendMessage(chatId, BUILDER_AGREEMENT, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ I agree — submit my application', callback_data: 'apply:agree' }],
        [{ text: '✖ Cancel', callback_data: 'apply:cancel' }],
      ],
    },
  });
}

export async function cancelApply(ctx, chatId) {
  ctx.sessions.delete(chatId);
  await ctx.bot.sendMessage(chatId, 'No problem — nothing was submitted. Apply anytime with /apply.');
}

// Agreement accepted → application is created and owners are pinged. The
// agreement timestamp is recorded now, so approval makes them instantly
// bookable with no extra steps.
export async function agreeAndSubmit(ctx, chatId, telegramId) {
  const s = ctx.sessions.get(chatId);
  if (s?.flow !== 'apply' || s.step !== 'agreement') return;
  ctx.sessions.delete(chatId);
  const d = s.data;
  await setBuilderAgreement(telegramId);
  const app = await createApplication({
    telegramId,
    username: d.username,
    name: d.name,
    hours: d.hours,
    rate: d.rate,
    phone: d.phone || null,
    baseAddress: d.baseAddress,
  });
  await ctx.bot.sendMessage(
    chatId,
    '✅ *Application submitted!*\nWe’ll review it and message you — once you’re approved you’ll be live and bookable immediately.',
    { parse_mode: 'Markdown' }
  );
  for (const adminId of config.adminIds) {
    try {
      await ctx.bot.sendMessage(
        adminId,
        `🧰 *New Block Expert application*\n` +
          `👤 ${d.name}${d.username ? ` (@${d.username})` : ''}\n` +
          `🕑 ${d.hours}\n💲 ${d.rate}\n📞 ${d.phone || '—'}\n📍 ${d.baseAddress}\n🤝 Agreement accepted`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Approve', callback_data: `adm:appok:${app.id}` },
                { text: '❌ Reject', callback_data: `adm:appno:${app.id}` },
              ],
            ],
          },
        }
      );
    } catch {
      /* owner hasn't opened the bot */
    }
  }
}
