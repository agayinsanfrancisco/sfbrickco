import { createClient } from '@supabase/supabase-js';
import { config, isAdminId } from './config.js';

export const supabase = createClient(
  config.supabase.url,
  config.supabase.serviceKey,
  { auth: { persistSession: false } }
);

// ── Users ────────────────────────────────────────────────────────────
// Ensure a user row exists for a Telegram account; promote to admin if the
// id is listed in ADMIN_TELEGRAM_IDS. Returns the user row.
export async function upsertUser({ telegramId, username, fullName }) {
  const { data: existing } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', telegramId)
    .maybeSingle();

  const wantAdmin = isAdminId(telegramId);

  if (existing) {
    const patch = {};
    if (username && username !== existing.username) patch.username = username;
    if (fullName && fullName !== existing.full_name) patch.full_name = fullName;
    // Never demote an expert to customer automatically, but always honor admin list.
    if (wantAdmin && existing.role !== 'admin') patch.role = 'admin';
    if (Object.keys(patch).length === 0) return applyBuilderInvite(existing);
    const { data } = await supabase
      .from('users')
      .update(patch)
      .eq('id', existing.id)
      .select('*')
      .single();
    return applyBuilderInvite(data);
  }

  const { data, error } = await supabase
    .from('users')
    .insert({
      telegram_id: telegramId,
      username,
      full_name: fullName,
      role: wantAdmin ? 'admin' : 'customer',
    })
    .select('*')
    .single();
  if (error) throw error;
  return applyBuilderInvite(data);
}

// Promote a user to builder ('expert') if their @handle was pre-invited by an
// admin. Matches case-insensitively; consumes the invite. No-op otherwise.
export async function applyBuilderInvite(user) {
  if (!user?.username || user.role === 'admin' || user.role === 'expert') return user;
  const handle = user.username.toLowerCase();
  const { data: invite } = await supabase
    .from('builder_invites')
    .select('username')
    .eq('username', handle)
    .maybeSingle();
  if (!invite) return user;
  const { data: updated } = await supabase
    .from('users')
    .update({ role: 'expert', active: true })
    .eq('id', user.id)
    .select('*')
    .single();
  await supabase.from('builder_invites').delete().eq('username', handle);
  return updated || user;
}

export async function addBuilderInvite(username) {
  const handle = String(username).replace(/^@/, '').trim().toLowerCase();
  if (!handle) return null;
  await supabase.from('builder_invites').upsert({ username: handle }, { onConflict: 'username' });
  return handle;
}

// A builder's own appointments (accepted/awaiting-payment), upcoming first.
export async function listBookingsForExpert(expertId) {
  const { data } = await supabase
    .from('bookings')
    .select('*')
    .eq('expert_id', expertId)
    .in('status', ['awaiting_payment', 'accepted'])
    .order('slot_start', { ascending: true });
  return data || [];
}

export async function getUserByTelegramId(telegramId) {
  const { data } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', telegramId)
    .maybeSingle();
  return data;
}

export async function getUserById(id) {
  const { data } = await supabase.from('users').select('*').eq('id', id).maybeSingle();
  return data;
}

export async function setRole(telegramId, role) {
  const { data, error } = await supabase
    .from('users')
    .update({ role })
    .eq('telegram_id', telegramId)
    .select('*')
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function setUserAddress(telegramId, address) {
  const { data } = await supabase
    .from('users')
    .update({ address })
    .eq('telegram_id', telegramId)
    .select('*')
    .maybeSingle();
  return data;
}

export async function setActive(telegramId, active) {
  const { data, error } = await supabase
    .from('users')
    .update({ active })
    .eq('telegram_id', telegramId)
    .select('*')
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function listUsers() {
  const { data } = await supabase
    .from('users')
    .select('*')
    .order('created_at', { ascending: true });
  return data || [];
}

export async function listExperts({ activeOnly = true } = {}) {
  let q = supabase.from('users').select('*').eq('role', 'expert');
  if (activeOnly) q = q.eq('active', true);
  const { data } = await q;
  return data || [];
}

// ── Orders (LEGO product sales) ──────────────────────────────────────
export async function createOrder({
  telegramId,
  sku,
  qty,
  amountCents, // item subtotal (delivery tracked separately)
  deliveryFeeCents = 0,
  deliveryAddress = null,
  contactPhone = null,
  contactHandle = null,
  notes = null,
  items = null, // multi-item cart line items (#17); null for single-item orders
}) {
  const { data, error } = await supabase
    .from('orders')
    .insert({
      telegram_id: telegramId,
      sku,
      qty,
      amount_cents: amountCents,
      delivery_fee_cents: deliveryFeeCents,
      delivery_address: deliveryAddress,
      contact_phone: contactPhone,
      contact_handle: contactHandle,
      notes,
      items,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

// Customer self-cancel: only while still pending (returns the row, or null).
export async function cancelOrder(id) {
  const { data } = await supabase
    .from('orders')
    .update({ status: 'cancelled' })
    .eq('id', id)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();
  return data;
}

// Cancel a booking that hasn't been paid yet → frees the slot (slotTaken only
// counts active statuses). Returns the row, or null if it wasn't cancellable.
export async function cancelBookingById(id) {
  const { data } = await supabase
    .from('bookings')
    .update({ status: 'cancelled' })
    .eq('id', id)
    .eq('payment_status', 'unpaid')
    .in('status', ['awaiting_acceptance', 'awaiting_payment'])
    .select('*')
    .maybeSingle();
  return data;
}

// Most recent delivery address this customer used (#42).
export async function lastDeliveryAddress(telegramId) {
  const { data } = await supabase
    .from('orders')
    .select('delivery_address')
    .eq('telegram_id', telegramId)
    .not('delivery_address', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.delivery_address || null;
}

// Attach the chosen coin + derived address + quoted amount + locked rate +
// expiry at pay time.
export async function updateOrderCrypto(
  id,
  { paymentMethod, cryptoAmount, payCoin, payAddress, payIndex, payExpiresAt = null, usdRate = null }
) {
  const { data } = await supabase
    .from('orders')
    .update({
      payment_method: paymentMethod,
      crypto_amount: cryptoAmount,
      pay_coin: payCoin,
      pay_address: payAddress,
      pay_index: payIndex,
      pay_expires_at: payExpiresAt,
      usd_rate: usdRate,
    })
    .eq('id', id)
    .select('*')
    .maybeSingle();
  return data;
}

// Record the on-chain funding tx for audit (best-effort, set at confirm time).
export async function recordOrderTx(id, { txid, blockHeight }) {
  await supabase
    .from('orders')
    .update({ pay_txid: txid, pay_block_height: blockHeight })
    .eq('id', id);
}

export async function markOrderRefunded(id, txid) {
  const { data } = await supabase
    .from('orders')
    .update({ status: 'refunded', refund_txid: txid, refunded_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .maybeSingle();
  return data;
}

export async function markOrderDispatched(id) {
  const { data } = await supabase
    .from('orders')
    .update({ status: 'dispatched' })
    .eq('id', id)
    .eq('status', 'paid')
    .select('*')
    .maybeSingle();
  return data;
}

export async function listPaidUndispatchedOrders() {
  const { data } = await supabase
    .from('orders')
    .select('*')
    .eq('status', 'paid')
    .order('created_at', { ascending: true });
  return data || [];
}

// dispatched → delivered (#20). Conditional so it's idempotent.
export async function markOrderDelivered(id) {
  const { data } = await supabase
    .from('orders')
    .update({ status: 'delivered' })
    .eq('id', id)
    .eq('status', 'dispatched')
    .select('*')
    .maybeSingle();
  return data;
}

// Abandoned-order sweep (#18): cancel stale unpaid orders/bookings.
export async function cancelStalePendingOrders(beforeIso) {
  const { data } = await supabase
    .from('orders')
    .update({ status: 'cancelled' })
    .eq('status', 'pending')
    .lt('created_at', beforeIso)
    .select('id');
  return data || [];
}

export async function cancelStaleUnpaidBookings(beforeIso) {
  const { data } = await supabase
    .from('bookings')
    .update({ status: 'cancelled' })
    .eq('payment_status', 'unpaid')
    .in('status', ['awaiting_acceptance', 'awaiting_payment'])
    .lt('created_at', beforeIso)
    .select('id');
  return data || [];
}

// Recent orders for admin ref-lookup (#38) — matched client-side by shortRef.
export async function listRecentOrders(limit = 200) {
  const { data } = await supabase
    .from('orders')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  return data || [];
}

// ── Products (catalog) ───────────────────────────────────────────────
export async function listProducts() {
  const { data } = await supabase
    .from('inventory')
    .select('*')
    .eq('active', true)
    .order('sort', { ascending: true });
  return data || [];
}

export async function getProduct(sku) {
  return getInventory(sku);
}

// Allocate the next derivation index for a coin. Atomic via the
// next_derivation_index() Postgres function (upsert+increment under a row
// lock) so concurrent payments can never receive the same address.
export async function nextDerivationIndex(coin) {
  const { data, error } = await supabase.rpc('next_derivation_index', { p_coin: coin });
  if (error) throw error;
  return data; // integer index to use for this payment
}

// Orders awaiting a crypto payment to a derived address, created recently.
export async function listWatchableOrders(sinceIso) {
  const { data } = await supabase
    .from('orders')
    .select('*')
    .eq('status', 'pending')
    .not('pay_address', 'is', null)
    .gt('created_at', sinceIso);
  return data || [];
}

export async function listWatchableBookings(sinceIso) {
  const { data } = await supabase
    .from('bookings')
    .select('*')
    .eq('payment_status', 'unpaid')
    .not('pay_address', 'is', null)
    .neq('surcharge_source', 'pending')
    .gt('created_at', sinceIso);
  return data || [];
}

export async function getOrder(id) {
  const { data } = await supabase.from('orders').select('*').eq('id', id).maybeSingle();
  return data;
}

// Conditional on still-pending, so confirming twice (watcher + admin) is a
// no-op the second time — returns null if it was already paid.
export async function markOrderPaid(orderId) {
  const { data } = await supabase
    .from('orders')
    .update({ status: 'paid' })
    .eq('id', orderId)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();
  return data;
}

// ── Bookings (expert setup service) ──────────────────────────────────
export async function createBooking(fields) {
  const { data, error } = await supabase
    .from('bookings')
    .insert(fields)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function getBooking(id) {
  const { data } = await supabase.from('bookings').select('*').eq('id', id).maybeSingle();
  return data;
}

export async function setBookingCrypto(
  id,
  {
    paymentMethod,
    cryptoAmount,
    payCoin = null,
    payAddress = null,
    payIndex = null,
    payExpiresAt = null,
    usdRate = null,
  }
) {
  const { data } = await supabase
    .from('bookings')
    .update({
      payment_method: paymentMethod,
      crypto_amount: cryptoAmount,
      pay_coin: payCoin,
      pay_address: payAddress,
      pay_index: payIndex,
      pay_expires_at: payExpiresAt,
      usd_rate: usdRate,
    })
    .eq('id', id)
    .select('*')
    .maybeSingle();
  return data;
}

export async function recordBookingTx(id, { txid, blockHeight }) {
  await supabase
    .from('bookings')
    .update({ pay_txid: txid, pay_block_height: blockHeight })
    .eq('id', id);
}

export async function markBookingRefunded(id, txid) {
  const { data } = await supabase
    .from('bookings')
    .update({ payment_status: 'refunded', refund_txid: txid, refunded_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .maybeSingle();
  return data;
}

// Builder already assigned at acceptance → paying confirms the job ('accepted').
// Conditional on still-unpaid, so a double confirm is a no-op (returns null).
export async function markBookingPaid(bookingId) {
  const { data } = await supabase
    .from('bookings')
    .update({ payment_status: 'paid', status: 'accepted' })
    .eq('id', bookingId)
    .eq('payment_status', 'unpaid')
    .select('*')
    .maybeSingle();
  return data;
}

export async function listPendingBookings() {
  const { data } = await supabase
    .from('bookings')
    .select('*')
    .eq('status', 'pending')
    .eq('payment_status', 'paid')
    .order('slot_start', { ascending: true });
  return data || [];
}

// Open (unpaid) bookings awaiting a builder to accept.
export async function listOpenBookings() {
  const { data } = await supabase
    .from('bookings')
    .select('*')
    .eq('status', 'awaiting_acceptance')
    .order('slot_start', { ascending: true });
  return data || [];
}

// A builder accepts an open job: assign them, set the travel surcharge priced
// from THEIR address, and move it to awaiting_payment. Conditional on still
// being open so two builders can't both win it.
export async function acceptOpenBooking(bookingId, expertId, { surchargeCents, totalCents }) {
  const { data, error } = await supabase
    .from('bookings')
    .update({
      status: 'awaiting_payment',
      expert_id: expertId,
      surcharge_cents: surchargeCents,
      surcharge_source: 'estimate',
      total_cents: totalCents,
    })
    .eq('id', bookingId)
    .eq('status', 'awaiting_acceptance')
    .select('*')
    .maybeSingle();
  if (error) throw error;
  return data; // null if another builder took it first
}

export async function declineBooking(bookingId) {
  const { data } = await supabase
    .from('bookings')
    .update({ status: 'declined' })
    .eq('id', bookingId)
    .select('*')
    .maybeSingle();
  return data;
}

export async function setBookingSurcharge(bookingId, { surchargeCents, source, totalCents }) {
  const { data } = await supabase
    .from('bookings')
    .update({
      surcharge_cents: surchargeCents,
      surcharge_source: source,
      total_cents: totalCents,
    })
    .eq('id', bookingId)
    .select('*')
    .maybeSingle();
  return data;
}

// Bookings whose slot has ended, were accepted, and haven't yet been
// prompted for a review.
export async function listBookingsNeedingReview(nowIso) {
  const { data } = await supabase
    .from('bookings')
    .select('*')
    .eq('status', 'accepted')
    .eq('review_prompted', false)
    .lt('slot_end', nowIso);
  return data || [];
}

export async function markReviewPrompted(bookingId) {
  await supabase
    .from('bookings')
    .update({ review_prompted: true, status: 'completed' })
    .eq('id', bookingId);
}

// Does this hour already have an active (pending/accepted) booking?
export async function slotTaken(slotStartIso) {
  const { data } = await supabase
    .from('bookings')
    .select('id')
    .eq('slot_start', slotStartIso)
    .in('status', ['awaiting_acceptance', 'awaiting_payment', 'pending', 'accepted'])
    .limit(1);
  return (data || []).length > 0;
}

// ── Reviews ──────────────────────────────────────────────────────────
export async function createReview({ bookingId, customerTelegramId, expertId, rating, comment }) {
  const { data, error } = await supabase
    .from('reviews')
    .upsert(
      {
        booking_id: bookingId,
        customer_telegram_id: customerTelegramId,
        expert_id: expertId,
        rating,
        comment,
      },
      { onConflict: 'booking_id' }
    )
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function updateReviewComment(bookingId, comment) {
  await supabase.from('reviews').update({ comment }).eq('booking_id', bookingId);
}

// Average rating + count for a builder (#21).
export async function expertRatingSummary(expertId) {
  if (!expertId) return { avg: null, count: 0 };
  const { data } = await supabase.from('reviews').select('rating').eq('expert_id', expertId);
  const rows = data || [];
  if (!rows.length) return { avg: null, count: 0 };
  const avg = rows.reduce((s, r) => s + r.rating, 0) / rows.length;
  return { avg: Math.round(avg * 10) / 10, count: rows.length };
}

// ── Booking reminders (#41) ──────────────────────────────────────────
export async function listBookingsNeedingReminder(nowIso, soonIso) {
  const { data } = await supabase
    .from('bookings')
    .select('*')
    .eq('status', 'accepted')
    .eq('payment_status', 'paid')
    .eq('reminded', false)
    .gte('slot_start', nowIso)
    .lte('slot_start', soonIso);
  return data || [];
}

export async function markReminded(id) {
  await supabase.from('bookings').update({ reminded: true }).eq('id', id);
}

// ── Expert availability windows (#22) ────────────────────────────────
export async function getExpertAvailability(expertId) {
  const { data } = await supabase
    .from('expert_availability')
    .select('*')
    .eq('expert_id', expertId)
    .order('dow', { ascending: true });
  return data || [];
}

// Replace a builder's whole weekly schedule.
export async function setExpertAvailability(expertId, windows) {
  await supabase.from('expert_availability').delete().eq('expert_id', expertId);
  if (windows.length) {
    await supabase
      .from('expert_availability')
      .insert(windows.map((w) => ({ expert_id: expertId, ...w })));
  }
}

// All availability for active experts (used to filter slots + notifications).
export async function listActiveAvailability() {
  const { data } = await supabase
    .from('expert_availability')
    .select('expert_id, dow, start_hour, end_hour, users!inner(active, role)')
    .eq('users.active', true)
    .eq('users.role', 'expert');
  return data || [];
}

// ── Inventory ────────────────────────────────────────────────────────
export async function getInventory(sku) {
  const { data } = await supabase.from('inventory').select('*').eq('sku', sku).maybeSingle();
  return data;
}

export async function listInventory() {
  const { data } = await supabase.from('inventory').select('*').order('sku');
  return data || [];
}

// ── Analytics events (#49) ───────────────────────────────────────────
export async function logEvent(telegramId, kind, meta = null) {
  try {
    await supabase.from('events').insert({ telegram_id: telegramId, kind, meta });
  } catch {
    /* analytics must never break a flow */
  }
}

// ── Promo codes (#19) ────────────────────────────────────────────────
export async function getPromo(code) {
  const { data } = await supabase
    .from('promo_codes')
    .select('*')
    .eq('code', String(code).trim().toLowerCase())
    .maybeSingle();
  return data;
}

// Atomically increment uses (active + under max_uses); returns the row or null.
export async function redeemPromo(code) {
  const { data, error } = await supabase.rpc('redeem_promo', {
    p_code: String(code).trim().toLowerCase(),
  });
  if (error) throw error;
  return data ?? null;
}

export async function setOrderPromo(orderId, { code, discountCents }) {
  const { data } = await supabase
    .from('orders')
    .update({ promo_code: code, discount_cents: discountCents })
    .eq('id', orderId)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();
  return data;
}

export async function createPromo({ code, percentOff = null, amountOffCents = null, maxUses = null }) {
  const { data, error } = await supabase
    .from('promo_codes')
    .insert({
      code: String(code).trim().toLowerCase(),
      percent_off: percentOff,
      amount_off_cents: amountOffCents,
      max_uses: maxUses,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

// ── Settings (admin-editable key/value) (#44) ────────────────────────
export async function getAllSettings() {
  const { data } = await supabase.from('settings').select('key, value');
  return data || [];
}

export async function setSetting(key, value) {
  await supabase
    .from('settings')
    .upsert({ key, value: String(value), updated_at: new Date().toISOString() }, { onConflict: 'key' });
}

// ── Price editing + add SKU (#29) ────────────────────────────────────
export async function setProductPrice(sku, { unitPriceCents, bundleQty = null, bundlePriceCents = null }) {
  const patch = { unit_price_cents: unitPriceCents, updated_at: new Date().toISOString() };
  if (bundleQty != null) patch.bundle_qty = bundleQty;
  if (bundlePriceCents != null) patch.bundle_price_cents = bundlePriceCents;
  const { data } = await supabase.from('inventory').update(patch).eq('sku', sku).select('*').maybeSingle();
  return data;
}

export async function createProduct({ sku, name, unitPriceCents, stockQty = 0 }) {
  const { data, error } = await supabase
    .from('inventory')
    .insert({
      sku,
      name,
      unit_price_cents: unitPriceCents,
      price_mode: 'unit_bundle',
      stock_qty: stockQty,
      active: true,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function setProductActive(sku, active) {
  const { data } = await supabase
    .from('inventory')
    .update({ active, updated_at: new Date().toISOString() })
    .eq('sku', sku)
    .select('*')
    .maybeSingle();
  return data;
}

export async function setStock(sku, qty) {
  const { data } = await supabase
    .from('inventory')
    .update({ stock_qty: qty, updated_at: new Date().toISOString() })
    .eq('sku', sku)
    .select('*')
    .maybeSingle();
  return data;
}

// Decrement only if enough stock remains. Atomic via the decrement_stock()
// Postgres function (single conditional UPDATE under a row lock) so two
// confirmations can't oversell. Returns { sku, stock_qty } with the remaining
// count, or null if there wasn't enough stock.
export async function decrementStock(sku, qty) {
  const { data, error } = await supabase.rpc('decrement_stock', { p_sku: sku, p_qty: qty });
  if (error) throw error;
  if (data === null || data === undefined) return null;
  return { sku, stock_qty: data };
}

// ── Atomic stock reservation (#39) ───────────────────────────────────
// Reserve stock against available (stock_qty − reserved_qty) at order time;
// release on payment/cancel/expiry. Returns available-after, or null if
// insufficient. Wired into the order + cancellation flows in later phases.
export async function reserveStock(sku, qty) {
  const { data, error } = await supabase.rpc('reserve_stock', { p_sku: sku, p_qty: qty });
  if (error) throw error;
  return data ?? null;
}

export async function releaseReservation(sku, qty) {
  const { error } = await supabase.rpc('release_reservation', { p_sku: sku, p_qty: qty });
  if (error) throw error;
}

// ── Wallet: balance ledger (#prepaid wallet) ─────────────────────────
// All balance mutations go through the credit_balance / debit_balance
// Postgres functions, which update users.balance_cents and append a ledger
// row atomically under a row lock.
export async function getBalance(telegramId) {
  const { data } = await supabase
    .from('users')
    .select('balance_cents')
    .eq('telegram_id', telegramId)
    .maybeSingle();
  return data?.balance_cents ?? 0;
}

export async function creditBalance(telegramId, deltaCents, { kind, refType = null, refId = null }) {
  const { data, error } = await supabase.rpc('credit_balance', {
    p_telegram_id: telegramId,
    p_delta_cents: deltaCents,
    p_kind: kind,
    p_ref_type: refType,
    p_ref_id: refId,
  });
  if (error) throw error;
  return data; // new balance
}

// Returns the new balance, or null if the balance was insufficient.
export async function debitBalance(telegramId, amountCents, { refType = null, refId = null } = {}) {
  const { data, error } = await supabase.rpc('debit_balance', {
    p_telegram_id: telegramId,
    p_amount_cents: amountCents,
    p_ref_type: refType,
    p_ref_id: refId,
  });
  if (error) throw error;
  return data ?? null;
}

export async function listLedger(telegramId, limit = 10) {
  const { data } = await supabase
    .from('ledger')
    .select('*')
    .eq('telegram_id', telegramId)
    .order('created_at', { ascending: false })
    .limit(limit);
  return data || [];
}

// ── Deposits (wallet top-ups, watched on-chain) ──────────────────────
export async function createDeposit({
  telegramId,
  payCoin,
  payAddress,
  payIndex,
  cryptoAmount,
  usdCents,
  payExpiresAt = null,
  usdRate = null,
}) {
  const { data, error } = await supabase
    .from('deposits')
    .insert({
      telegram_id: telegramId,
      pay_coin: payCoin,
      pay_address: payAddress,
      pay_index: payIndex,
      crypto_amount: cryptoAmount,
      usd_cents: usdCents,
      pay_expires_at: payExpiresAt,
      usd_rate: usdRate,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function getDeposit(id) {
  const { data } = await supabase.from('deposits').select('*').eq('id', id).maybeSingle();
  return data;
}

export async function listWatchableDeposits(sinceIso) {
  const { data } = await supabase
    .from('deposits')
    .select('*')
    .eq('status', 'pending')
    .not('pay_address', 'is', null)
    .gt('created_at', sinceIso);
  return data || [];
}

export async function expireDeposit(id) {
  await supabase.from('deposits').update({ status: 'expired' }).eq('id', id).eq('status', 'pending');
}

// Conditional on still-pending so a double credit is a no-op (returns null).
export async function markDepositCredited(id, { creditedCents, txid = null, blockHeight = null }) {
  const { data } = await supabase
    .from('deposits')
    .update({
      status: 'credited',
      credited_cents: creditedCents,
      pay_txid: txid,
      pay_block_height: blockHeight,
    })
    .eq('id', id)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();
  return data;
}

// ── Account self-service (#1) ────────────────────────────────────────
export async function listOrdersByTelegramId(telegramId, limit = 5) {
  const { data } = await supabase
    .from('orders')
    .select('*')
    .eq('telegram_id', telegramId)
    .order('created_at', { ascending: false })
    .limit(limit);
  return data || [];
}

export async function listBookingsByCustomer(telegramId, limit = 5) {
  const { data } = await supabase
    .from('bookings')
    .select('*')
    .eq('customer_telegram_id', telegramId)
    .order('created_at', { ascending: false })
    .limit(limit);
  return data || [];
}
