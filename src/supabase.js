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
    if (Object.keys(patch).length === 0) return existing;
    const { data } = await supabase
      .from('users')
      .update(patch)
      .eq('id', existing.id)
      .select('*')
      .single();
    return data;
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
  return data;
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
  qty,
  amountCents,
  paymentMethod = 'stripe',
  cryptoAmount = null,
  payCoin = null,
  payAddress = null,
  payIndex = null,
}) {
  const { data, error } = await supabase
    .from('orders')
    .insert({
      telegram_id: telegramId,
      qty,
      amount_cents: amountCents,
      payment_method: paymentMethod,
      crypto_amount: cryptoAmount,
      pay_coin: payCoin,
      pay_address: payAddress,
      pay_index: payIndex,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

// Allocate the next derivation index for a coin (read-modify-write; fine at
// this volume). Returns the index to use for this payment.
export async function nextDerivationIndex(coin) {
  const { data: row } = await supabase
    .from('pay_counters')
    .select('next_index')
    .eq('coin', coin)
    .maybeSingle();
  const idx = row?.next_index ?? 0;
  await supabase
    .from('pay_counters')
    .update({ next_index: idx + 1 })
    .eq('coin', coin)
    .eq('next_index', idx);
  return idx;
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

export async function attachOrderSession(orderId, sessionId) {
  await supabase.from('orders').update({ stripe_session_id: sessionId }).eq('id', orderId);
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

export async function attachBookingSession(bookingId, sessionId) {
  await supabase
    .from('bookings')
    .update({ stripe_session_id: sessionId })
    .eq('id', bookingId);
}

export async function getBooking(id) {
  const { data } = await supabase.from('bookings').select('*').eq('id', id).maybeSingle();
  return data;
}

export async function setBookingCrypto(
  id,
  { paymentMethod, cryptoAmount, payCoin = null, payAddress = null, payIndex = null }
) {
  const { data } = await supabase
    .from('bookings')
    .update({
      payment_method: paymentMethod,
      crypto_amount: cryptoAmount,
      pay_coin: payCoin,
      pay_address: payAddress,
      pay_index: payIndex,
    })
    .eq('id', id)
    .select('*')
    .maybeSingle();
  return data;
}

// Conditional on still-unpaid, so a double confirm is a no-op (returns null).
export async function markBookingPaid(bookingId) {
  const { data } = await supabase
    .from('bookings')
    .update({ payment_status: 'paid', status: 'pending' })
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

// Accept a paid+pending booking, assigning an expert. Uses a conditional
// update so two experts can't both win the same slot.
export async function acceptBooking(bookingId, expertId) {
  const { data, error } = await supabase
    .from('bookings')
    .update({ status: 'accepted', expert_id: expertId })
    .eq('id', bookingId)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();
  if (error) throw error;
  return data; // null if it was already taken
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
    .in('status', ['pending', 'accepted'])
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

// ── Inventory ────────────────────────────────────────────────────────
export async function getInventory(sku) {
  const { data } = await supabase.from('inventory').select('*').eq('sku', sku).maybeSingle();
  return data;
}

export async function listInventory() {
  const { data } = await supabase.from('inventory').select('*').order('sku');
  return data || [];
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

// Decrement only if enough stock remains. Returns the updated row, or null if
// insufficient (the .gte guard makes the conditional update race-safe enough
// for this volume).
export async function decrementStock(sku, qty) {
  const inv = await getInventory(sku);
  if (!inv || inv.stock_qty < qty) return null;
  const { data } = await supabase
    .from('inventory')
    .update({ stock_qty: inv.stock_qty - qty, updated_at: new Date().toISOString() })
    .eq('sku', sku)
    .gte('stock_qty', qty)
    .select('*')
    .maybeSingle();
  return data;
}
