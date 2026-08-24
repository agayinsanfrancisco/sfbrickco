// Per-chat Telegram command menus. The global command list stays
// customer-only; experts and staff get their extra commands registered for
// their own chat, so /builder and /owner appear in their "/" menu the moment
// they're approved or promoted.

export const BASE_COMMANDS = [
  { command: 'shop', description: 'Browse & order 3D-printed parts' },
  { command: 'book', description: 'Book a Block Expert (on-site build help)' },
  { command: 'wallet', description: 'Add funds & check your balance' },
  { command: 'orders', description: 'Your recent orders & bookings' },
  { command: 'help', description: 'How this bot works' },
];

export async function refreshChatCommands(bot, chatId, { isExpert = false, isStaffMember = false } = {}) {
  const cmds = [...BASE_COMMANDS];
  if (isExpert) cmds.push({ command: 'builder', description: 'Block Expert portal (jobs, hours, rate)' });
  if (isStaffMember) cmds.push({ command: 'owner', description: 'Staff panel' });
  try {
    await bot.setMyCommands(cmds, { scope: { type: 'chat', chat_id: chatId } });
  } catch {
    /* best-effort — chat may not exist yet */
  }
}
