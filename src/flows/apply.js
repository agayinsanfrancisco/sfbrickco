import { config } from '../config.js';
import { createApplication, getPendingApplication, getUserByTelegramId } from '../supabase.js';

// Multi-step application to become a Block Expert. Anyone can apply, but every
// application is gated: it sits in `admin_applications` as `pending` until an
// owner explicitly approves it (adm:appok) — only then is the user promoted to
// the expert role. One pending application per person; already-approved Block
// Experts are pointed at their portal instead.
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
      'Sound good? A few quick questions.\n\nFirst — what’s your *full name*?',
    { parse_mode: 'Markdown', reply_markup: { force_reply: true, input_field_placeholder: 'Jane Builder' } }
  );
}

export async function receiveName(ctx, chatId, name) {
  const s = ctx.sessions.get(chatId);
  if (s?.flow !== 'apply' || s.step !== 'name') return;
  ctx.sessions.set(chatId, { ...s, step: 'hours', data: { ...s.data, name } });
  await ctx.bot.sendMessage(
    chatId,
    'What *hours* would you like to operate? (e.g. “Mon–Fri 9am–6pm, weekends flexible”)',
    { parse_mode: 'Markdown', reply_markup: { force_reply: true } }
  );
}

export async function receiveHours(ctx, chatId, hours) {
  const s = ctx.sessions.get(chatId);
  if (s?.flow !== 'apply' || s.step !== 'hours') return;
  ctx.sessions.set(chatId, { ...s, step: 'rate', data: { ...s.data, hours } });
  const fee = config.pricing.platformFeePct;
  await ctx.bot.sendMessage(
    chatId,
    `How much do you *charge* per 1-hour session? (e.g. “$40”)\n\n` +
      `Heads up: we take a *${fee}% platform fee*, so you’d keep *${100 - fee}%* of that.`,
    { parse_mode: 'Markdown', reply_markup: { force_reply: true, input_field_placeholder: '$40' } }
  );
}

export async function receiveRate(ctx, chatId, rate) {
  const s = ctx.sessions.get(chatId);
  if (s?.flow !== 'apply' || s.step !== 'rate') return;
  ctx.sessions.set(chatId, { ...s, step: 'address', data: { ...s.data, rate } });
  await ctx.bot.sendMessage(
    chatId,
    'Last one — where are you *usually located*? Give the address an Uber would pick you up from.',
    {
      parse_mode: 'Markdown',
      reply_markup: { force_reply: true, input_field_placeholder: '123 Main St, San Francisco, CA 94110' },
    }
  );
}

export async function receiveAddress(ctx, chatId, telegramId, username, baseAddress) {
  const s = ctx.sessions.get(chatId);
  if (s?.flow !== 'apply' || s.step !== 'address') return;
  ctx.sessions.delete(chatId);
  const app = await createApplication({
    telegramId,
    username: username || null,
    name: s.data.name,
    hours: s.data.hours,
    rate: s.data.rate,
    baseAddress,
  });
  await ctx.bot.sendMessage(
    chatId,
    '✅ Application submitted! We’ll review it and let you know. Thanks for your interest in joining as a Block Expert.'
  );
  // Notify owners for review.
  for (const adminId of config.adminIds) {
    try {
      await ctx.bot.sendMessage(
        adminId,
        `🧰 *New Block Expert application*\n` +
          `👤 ${s.data.name}${username ? ` (@${username})` : ''}\n` +
          `🕑 ${s.data.hours}\n💲 ${s.data.rate}\n📍 ${baseAddress}`,
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
