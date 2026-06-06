// Inline-keyboard builders. Callback data is kept under Telegram's 64-byte
// limit by using short prefixes + a single id/value.

export function mainMenu({ isExpert, isAdmin } = {}) {
  const rows = [
    [{ text: '🧱 Shop bricks & parts', callback_data: 'shop:start' }],
    [{ text: '🛠️ Book build help', callback_data: 'book:start' }],
    [
      { text: '💰 Wallet', callback_data: 'wal:menu' },
      { text: '🧾 My orders', callback_data: 'acct:orders' },
    ],
  ];
  if (isExpert) {
    rows.push([{ text: '📋 My jobs (builder)', callback_data: 'exp:list' }]);
    rows.push([{ text: '📍 Update my address', callback_data: 'exp:addr' }]);
  }
  if (isAdmin) rows.push([{ text: '⚙️ Admin panel', callback_data: 'adm:menu' }]);
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

export function adminMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '👥 List users', callback_data: 'adm:users' }],
        [{ text: '➕ Add builder', callback_data: 'adm:addexpert' }],
        [{ text: '➖ Remove user', callback_data: 'adm:remove' }],
        [{ text: '📋 Pending bookings', callback_data: 'adm:bookings' }],
        [{ text: '📦 Open orders', callback_data: 'adm:orders' }],
        [{ text: '🔎 Find order', callback_data: 'adm:find' }],
        [{ text: '📣 Broadcast', callback_data: 'adm:broadcast' }],
        [{ text: '📦 Inventory', callback_data: 'adm:inv' }],
      ],
    },
  };
}
