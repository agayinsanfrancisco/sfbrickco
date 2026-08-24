// Inline-keyboard builders. Callback data is kept under Telegram's 64-byte
// limit by using short prefixes + a single id/value.
import { can } from './roles.js';

export function mainMenu({ isExpert, isAdmin } = {}) {
  const rows = [
    [{ text: '🧱 Shop bricks & parts', callback_data: 'shop:start' }],
    [{ text: '🛠️ Book a Block Expert', callback_data: 'book:start' }],
    [
      { text: '💰 Wallet', callback_data: 'wal:menu' },
      { text: '🧾 My orders', callback_data: 'acct:orders' },
    ],
    [{ text: '🧰 Apply to be a Block Expert', callback_data: 'apply:start' }],
  ];
  if (isExpert) {
    rows.push([{ text: '📋 My jobs (Block Expert)', callback_data: 'exp:list' }]);
    rows.push([{ text: '📍 Update my address', callback_data: 'exp:addr' }]);
  }
  if (isAdmin) rows.push([{ text: '⚙️ Staff panel', callback_data: 'adm:menu' }]);
  return { reply_markup: { inline_keyboard: rows } };
}

export function qtyKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '1', callback_data: 'shop:qty:1' },
          { text: '2', callback_data: 'shop:qty:2' },
          { text: '3', callback_data: 'shop:qty:3' },
        ],
        [
          { text: '6 (bundle)', callback_data: 'shop:qty:6' },
          { text: '12 (bundle)', callback_data: 'shop:qty:12' },
        ],
        [{ text: 'Other amount…', callback_data: 'shop:qty:custom' }],
      ],
    },
  };
}

export function daysKeyboard(days) {
  const rows = days.map((d) => [
    { text: d.label, callback_data: `book:day:${d.dateKey}` },
  ]);
  return { reply_markup: { inline_keyboard: rows } };
}

// Hour buttons, 3 per row.
export function hoursKeyboard(slots) {
  const rows = [];
  for (let i = 0; i < slots.length; i += 3) {
    rows.push(
      slots.slice(i, i + 3).map((s) => ({
        text: s.label,
        callback_data: `book:hour:${s.startIso}`,
      }))
    );
  }
  if (rows.length === 0) {
    rows.push([{ text: '← Pick another day', callback_data: 'book:start' }]);
  }
  return { reply_markup: { inline_keyboard: rows } };
}

export function confirmBookingKeyboard(bookingId) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '💳 Pay & request', callback_data: `book:pay:${bookingId}` }],
        [{ text: '✖ Cancel', callback_data: 'book:cancel' }],
      ],
    },
  };
}

export function expertJobKeyboard(bookingId) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Accept', callback_data: `exp:acc:${bookingId}` },
          { text: '❌ Decline', callback_data: `exp:dec:${bookingId}` },
        ],
      ],
    },
  };
}

export function ratingKeyboard(bookingId) {
  return {
    reply_markup: {
      inline_keyboard: [
        [1, 2, 3, 4, 5].map((n) => ({
          text: '⭐'.repeat(n) || `${n}`,
          callback_data: `rev:rate:${bookingId}:${n}`,
        })),
      ],
    },
  };
}

// Owner panel is a drill-down: top level = category buttons, each opens its
// own section (see adminCategory). Keeps the panel short and tidy.
// Panel top level, filtered by what the caller's role can actually open.
export function adminMenu(role) {
  const rows = [];
  if (can(role, 'view_users') || can(role, 'manage_experts') || can(role, 'manage_roles'))
    rows.push([{ text: '👥 People', callback_data: 'adm:cat:people' }]);
  if (can(role, 'manage_orders') || can(role, 'manage_experts'))
    rows.push([{ text: '📦 Orders & Bookings', callback_data: 'adm:cat:orders' }]);
  if (can(role, 'catalog')) rows.push([{ text: '🧱 Catalog & Promos', callback_data: 'adm:cat:catalog' }]);
  if (can(role, 'settings') || can(role, 'broadcast'))
    rows.push([{ text: '⚙️ Settings', callback_data: 'adm:cat:settings' }]);
  if (can(role, 'testmode'))
    rows.push([{ text: '🧪 Test mode (view as / simulate pay)', callback_data: 'adm:test' }]);
  return { reply_markup: { inline_keyboard: rows } };
}

// Each button carries the capability that unlocks it; adminCategory filters
// per caller role so managers only see what they can actually use.
const ADMIN_CATEGORIES = {
  people: {
    title: '👥 People',
    buttons: [
      { text: '👥 Users', callback_data: 'adm:users', cap: 'view_users' },
      { text: '🧰 Apps', callback_data: 'adm:apps', cap: 'approve_applications' },
      { text: '🛠️ Block Experts', callback_data: 'adm:experts', cap: 'manage_experts' },
      { text: '➕ Invite expert', callback_data: 'adm:addexpert', cap: 'manage_experts' },
      { text: '🎖️ Roles', callback_data: 'adm:roles', cap: 'manage_roles' },
      { text: '➖ Remove user', callback_data: 'adm:remove', cap: 'manage_roles' },
      { text: '🔁 Repeat customers', callback_data: 'adm:repeat', cap: 'reports' },
      { text: '💸 Builder payouts', callback_data: 'adm:payouts', cap: 'payouts' },
    ],
  },
  orders: {
    title: '📦 Orders & Bookings',
    buttons: [
      { text: '📦 Open orders', callback_data: 'adm:orders', cap: 'manage_orders' },
      { text: '🔎 Find order', callback_data: 'adm:find', cap: 'manage_orders' },
      { text: '📋 Bookings', callback_data: 'adm:bookings', cap: 'manage_experts' },
      { text: '📤 Export CSV', callback_data: 'adm:csv', cap: 'reports' },
    ],
  },
  catalog: {
    title: '🧱 Catalog & Promos',
    buttons: [
      { text: '📦 Inventory', callback_data: 'adm:inv', cap: 'catalog' },
      { text: '🏷️ Add promo', callback_data: 'adm:addpromo', cap: 'catalog' },
    ],
  },
  settings: {
    title: '⚙️ Settings',
    buttons: [
      { text: '💲 Fees', callback_data: 'adm:fees', cap: 'settings' },
      { text: '🎚️ Features', callback_data: 'adm:features', cap: 'settings' },
      { text: '📣 Broadcast', callback_data: 'adm:broadcast', cap: 'broadcast' },
    ],
  },
};

// Keyboard for one panel category: the caller's permitted actions, two per
// row, plus a back button. Returns null if the category has nothing for them.
export function adminCategory(cat, role) {
  const c = ADMIN_CATEGORIES[cat];
  if (!c) return null;
  const allowed = c.buttons.filter((b) => can(role, b.cap)).map(({ text, callback_data }) => ({ text, callback_data }));
  if (!allowed.length) return null;
  const rows = [];
  for (let i = 0; i < allowed.length; i += 2) rows.push(allowed.slice(i, i + 2));
  return {
    title: c.title,
    reply_markup: { inline_keyboard: [...rows, [{ text: '⬅️ Back to panel', callback_data: 'adm:menu' }]] },
  };
}
