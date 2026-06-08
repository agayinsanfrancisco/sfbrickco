import { config } from '../config.js';
import { createApplication } from '../supabase.js';

// Multi-step application to become an Administrator. Anyone can apply; the owner
// reviews + approves in the owner panel.
export async function startApply(ctx, chatId) {
  ctx.sessions.set(chatId, { flow: 'apply', step: 'name', data: {} });
  await ctx.bot.sendMessage(
    chatId,
    '🧰 *Apply to be an Administrator*\n\n' +
      'We bring on vetted local builders to take on-site jobs. A few quick questions.\n\n' +
      'First — what’s your *full name*?',
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
  await ctx.bot.sendMessage(chatId, 'How much do you *charge* per session? (e.g. “$40 flat”)', {
    parse_mode: 'Markdown',
    reply_markup: { force_reply: true, input_field_placeholder: '$40' },
  });
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
    '✅ Application submitted! We’ll review it and let you know. Thanks for your interest in joining as an Administrator.'
  );
  // Notify owners for review.
  for (const adminId of config.adminIds) {
    try {
      await ctx.bot.sendMessage(
        adminId,
        `🧰 *New Administrator application*\n` +
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
