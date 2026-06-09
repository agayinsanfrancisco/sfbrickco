-- SF Brick Company — Supabase schema (canonical source of truth)
-- Run in the Supabase SQL editor (or `supabase db push`) before first start.
-- gen_random_uuid() comes from pgcrypto, enabled by default on Supabase.
-- All tables are service-role only (RLS enabled, no public policies).

-- ── Users ────────────────────────────────────────────────────────────
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  telegram_id   bigint unique not null,
  username      text,
  full_name     text,
  role          text not null default 'customer'
                  check (role in ('customer', 'expert', 'admin')),
  active        boolean not null default true,
  address       text,                          -- Administrator base/pickup address
  rate_cents    integer,                        -- Administrator's per-session rate (null = global default)
  balance_cents integer not null default 0,     -- prepaid wallet balance (USD cents)
  created_at    timestamptz not null default now()
);
alter table users enable row level security;

-- ── Orders (3D-printed accessory sales) ──────────────────────────────
create table if not exists orders (
  id                 uuid primary key default gen_random_uuid(),
  telegram_id        bigint not null,
  sku                text,
  qty                int not null check (qty > 0),
  amount_cents       int not null check (amount_cents >= 0),   -- item subtotal
  delivery_fee_cents int not null default 0,
  delivery_address   text,
  contact_phone      text,
  contact_handle     text,
  notes              text,                       -- optional delivery instructions (#32)
  status             text not null default 'pending'
                       check (status in ('pending', 'paid', 'accepted', 'dispatched',
                                         'delivered', 'cancelled', 'refunded')),
  -- payment (crypto)
  payment_method     text,
  crypto_amount      text,
  pay_coin           text,
  pay_address        text,
  pay_index          int,
  pay_expires_at     timestamptz,                -- quote/address validity (#2)
  usd_rate           numeric,                    -- locked USD/coin rate at quote time (#16)
  pay_txid           text,                       -- on-chain funding tx (#8)
  pay_block_height   int,
  refund_txid        text,                       -- refund record (#37)
  refunded_at        timestamptz,
  idempotency_key    text,                       -- dedupe double-submits (#48)
  discount_cents     int not null default 0,     -- promo discount (#19)
  promo_code         text,
  items              jsonb,                       -- multi-item cart line items (#17)
  waiver_accepted_at timestamptz,                 -- checkout waiver acceptance
  created_at         timestamptz not null default now()
);
create unique index if not exists orders_idempotency_key_uq
  on orders (idempotency_key) where idempotency_key is not null;
create index if not exists orders_status_created_idx on orders (status, created_at);

-- ── Bookings (on-site build-help service) ────────────────────────────
create table if not exists bookings (
  id                    uuid primary key default gen_random_uuid(),
  customer_telegram_id  bigint not null,
  customer_address      text,
  expert_id             uuid references users(id),
  slot_start            timestamptz not null,
  slot_end              timestamptz not null,
  service_fee_cents     int not null default 5000,
  surcharge_cents       int not null default 0,
  surcharge_source      text not null default 'pending'
                          check (surcharge_source in ('estimate', 'manual', 'pending', 'customer_ride')),
  customer_books_ride   boolean not null default false,  -- customer books the ride → no travel fee
  distance_miles        numeric,
  total_cents           int not null,
  payment_status        text not null default 'unpaid'
                          check (payment_status in ('unpaid', 'paid', 'refunded')),
  status                text not null default 'awaiting_payment'
                          check (status in ('awaiting_acceptance', 'awaiting_payment',
                                            'pending', 'accepted', 'declined',
                                            'completed', 'cancelled')),
  review_prompted       boolean not null default false,
  reminded              boolean not null default false,  -- pre-slot reminder sent (#41)
  -- payment (crypto)
  payment_method        text,
  crypto_amount         text,
  pay_coin              text,
  pay_address           text,
  pay_index             int,
  pay_expires_at        timestamptz,
  usd_rate              numeric,
  pay_txid              text,
  pay_block_height      int,
  refund_txid           text,
  refunded_at           timestamptz,
  created_at            timestamptz not null default now()
);
create index if not exists bookings_status_idx on bookings (status, payment_status);
create index if not exists bookings_slot_idx on bookings (slot_start);
create index if not exists bookings_paystatus_created_idx on bookings (payment_status, created_at);

-- ── Reviews (post-appointment) ───────────────────────────────────────
create table if not exists reviews (
  id                    uuid primary key default gen_random_uuid(),
  booking_id            uuid unique references bookings(id),
  customer_telegram_id  bigint not null,
  expert_id             uuid references users(id),
  rating                int not null check (rating between 1 and 5),
  comment               text,
  created_at            timestamptz not null default now()
);

-- ── Inventory (product catalog) ──────────────────────────────────────
create table if not exists inventory (
  id                 uuid primary key default gen_random_uuid(),
  sku                text unique not null,
  name               text not null,
  stock_qty          int not null default 0 check (stock_qty >= 0),
  reserved_qty       int not null default 0,     -- held by pending orders (#39)
  price_mode         text not null default 'unit_bundle',  -- 'unit_bundle' | 'packs'
  unit_price_cents   int,
  bundle_qty         int,
  bundle_price_cents int,
  packs              jsonb,
  active             boolean not null default true,
  sort               int not null default 0,
  updated_at         timestamptz not null default now()
);

-- ── Payment derivation counters (one row per coin) ───────────────────
create table if not exists pay_counters (
  coin        text primary key,
  next_index  int not null default 0
);

-- ── Expert availability windows (weekly, Pacific) ────────────────────
create table if not exists expert_availability (
  id          uuid primary key default gen_random_uuid(),
  expert_id   uuid not null references users(id),
  dow         int not null check (dow between 0 and 6),     -- 0=Sunday
  start_hour  int not null check (start_hour between 0 and 23),
  end_hour    int not null check (end_hour between 1 and 24),
  created_at  timestamptz not null default now()
);
create index if not exists expert_avail_idx on expert_availability (expert_id);
alter table expert_availability enable row level security;

-- ── Expert one-off time off (specific blocked hours) ─────────────────
create table if not exists expert_time_off (
  id          uuid primary key default gen_random_uuid(),
  expert_id   uuid not null references users(id),
  slot_start  timestamptz not null,
  created_at  timestamptz not null default now(),
  unique (expert_id, slot_start)
);
create index if not exists expert_timeoff_idx on expert_time_off (expert_id);
alter table expert_time_off enable row level security;

-- ── Administrator applications (apply + approval) ────────────────────
create table if not exists admin_applications (
  id           uuid primary key default gen_random_uuid(),
  telegram_id  bigint not null,
  username     text,
  name         text,
  hours        text,
  rate         text,
  base_address text,
  status       text not null default 'pending'
                 check (status in ('pending', 'approved', 'rejected')),
  created_at   timestamptz not null default now(),
  reviewed_at  timestamptz
);
create index if not exists admin_apps_status_idx on admin_applications (status, created_at);
alter table admin_applications enable row level security;

-- ── Settings (admin-editable key/value) ──────────────────────────────
create table if not exists settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
alter table settings enable row level security;

-- ── Persisted bot sessions (survive redeploys) ───────────────────────
create table if not exists sessions (
  chat_id    bigint primary key,
  state      jsonb not null,
  updated_at timestamptz not null default now()
);
alter table sessions enable row level security;

-- ── Builder invites (pre-approved @handles) ──────────────────────────
create table if not exists builder_invites (
  username    text primary key,
  created_at  timestamptz not null default now()
);

-- ── Wallet ledger (append-only audit trail) ──────────────────────────
create table if not exists ledger (
  id            uuid primary key default gen_random_uuid(),
  telegram_id   bigint not null,
  delta_cents   integer not null,                 -- +credit / −debit
  kind          text not null
                  check (kind in ('deposit', 'purchase', 'refund', 'adjustment')),
  ref_type      text,                             -- 'order' | 'booking' | 'deposit'
  ref_id        uuid,
  balance_after integer not null,
  created_at    timestamptz not null default now()
);
create index if not exists ledger_telegram_created_idx on ledger (telegram_id, created_at desc);
alter table ledger enable row level security;

-- ── Deposits (watched on-chain top-ups) ──────────────────────────────
create table if not exists deposits (
  id             uuid primary key default gen_random_uuid(),
  telegram_id    bigint not null,
  pay_coin       text,
  pay_address    text,
  pay_index      int,
  crypto_amount  text,                            -- quoted amount for the QR
  usd_cents      int,                             -- intended deposit value
  credited_cents int,                             -- actual value credited on confirm
  usd_rate       numeric,
  pay_txid       text,
  pay_block_height int,
  status         text not null default 'pending'
                   check (status in ('pending', 'credited', 'expired')),
  pay_expires_at timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists deposits_status_created_idx on deposits (status, created_at);
alter table deposits enable row level security;

-- ── Promo codes (#19) ────────────────────────────────────────────────
create table if not exists promo_codes (
  code             text primary key,
  percent_off      int check (percent_off between 0 and 100),
  amount_off_cents int,
  active           boolean not null default true,
  max_uses         int,
  uses             int not null default 0,
  created_at       timestamptz not null default now()
);
alter table promo_codes enable row level security;

-- ── Analytics events (#49) ───────────────────────────────────────────
create table if not exists events (
  id          uuid primary key default gen_random_uuid(),
  telegram_id bigint,
  kind        text not null,
  meta        jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists events_kind_created_idx on events (kind, created_at);
alter table events enable row level security;

-- ── Atomic functions ─────────────────────────────────────────────────

-- Allocate the next BIP84 derivation index for a coin (atomic upsert+increment).
create or replace function next_derivation_index(p_coin text)
returns integer language plpgsql as $$
declare v_idx integer;
begin
  insert into pay_counters (coin, next_index) values (p_coin, 1)
  on conflict (coin) do update set next_index = pay_counters.next_index + 1
  returning next_index - 1 into v_idx;
  return v_idx;
end; $$;

-- Decrement stock only if enough remains; returns remaining, or null if insufficient.
create or replace function decrement_stock(p_sku text, p_qty integer)
returns integer language plpgsql as $$
declare v_remaining integer;
begin
  update inventory set stock_qty = stock_qty - p_qty, updated_at = now()
   where sku = p_sku and stock_qty >= p_qty
  returning stock_qty into v_remaining;
  return v_remaining;
end; $$;

-- Reserve against available (stock_qty − reserved_qty); returns available-after, or null.
create or replace function reserve_stock(p_sku text, p_qty integer)
returns integer language plpgsql as $$
declare v_avail integer;
begin
  update inventory set reserved_qty = reserved_qty + p_qty, updated_at = now()
   where sku = p_sku and (stock_qty - reserved_qty) >= p_qty
  returning (stock_qty - reserved_qty) into v_avail;
  return v_avail;
end; $$;

create or replace function release_reservation(p_sku text, p_qty integer)
returns void language plpgsql as $$
begin
  update inventory set reserved_qty = greatest(0, reserved_qty - p_qty), updated_at = now()
   where sku = p_sku;
end; $$;

-- Wallet: atomic credit (row-locked), append ledger row, return new balance.
create or replace function credit_balance(
  p_telegram_id bigint, p_delta_cents integer, p_kind text, p_ref_type text, p_ref_id uuid
) returns integer language plpgsql as $$
declare v_new integer;
begin
  update users set balance_cents = balance_cents + p_delta_cents
   where telegram_id = p_telegram_id
  returning balance_cents into v_new;
  if v_new is null then raise exception 'no user row for telegram_id %', p_telegram_id; end if;
  insert into ledger (telegram_id, delta_cents, kind, ref_type, ref_id, balance_after)
  values (p_telegram_id, p_delta_cents, p_kind, p_ref_type, p_ref_id, v_new);
  return v_new;
end; $$;

-- Wallet: atomic debit only if sufficient; returns new balance or null.
create or replace function debit_balance(
  p_telegram_id bigint, p_amount_cents integer, p_ref_type text, p_ref_id uuid
) returns integer language plpgsql as $$
declare v_new integer;
begin
  update users set balance_cents = balance_cents - p_amount_cents
   where telegram_id = p_telegram_id and balance_cents >= p_amount_cents
  returning balance_cents into v_new;
  if v_new is null then return null; end if;
  insert into ledger (telegram_id, delta_cents, kind, ref_type, ref_id, balance_after)
  values (p_telegram_id, -p_amount_cents, 'purchase', p_ref_type, p_ref_id, v_new);
  return v_new;
end; $$;

-- Promo: atomically redeem (active + under max_uses); returns the row or null.
create or replace function redeem_promo(p_code text)
returns promo_codes language plpgsql as $$
declare r promo_codes;
begin
  update promo_codes set uses = uses + 1
   where code = p_code and active = true and (max_uses is null or uses < max_uses)
  returning * into r;
  return r;
end; $$;
