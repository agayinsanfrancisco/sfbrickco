-- Heaux SF — Supabase schema
-- Run this in the Supabase SQL editor (or `supabase db push`) before first start.
-- gen_random_uuid() comes from pgcrypto, enabled by default on Supabase.

-- ── Users ────────────────────────────────────────────────────────────
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  telegram_id   bigint unique not null,
  username      text,
  full_name     text,
  role          text not null default 'customer'
                  check (role in ('customer', 'expert', 'admin')),
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- ── Orders (red LEGO product sales) ──────────────────────────────────
create table if not exists orders (
  id                 uuid primary key default gen_random_uuid(),
  telegram_id        bigint not null,
  qty                int not null check (qty > 0),
  amount_cents       int not null check (amount_cents >= 0),
  stripe_session_id  text,
  status             text not null default 'pending'
                       check (status in ('pending', 'paid', 'cancelled')),
  created_at         timestamptz not null default now()
);

-- ── Bookings (LEGO-expert setup service) ─────────────────────────────
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
                          check (surcharge_source in ('estimate', 'manual', 'pending')),
  distance_miles        numeric,
  total_cents           int not null,
  stripe_session_id     text,
  payment_status        text not null default 'unpaid'
                          check (payment_status in ('unpaid', 'paid')),
  status                text not null default 'awaiting_payment'
                          check (status in ('awaiting_payment', 'pending', 'accepted',
                                            'declined', 'completed', 'cancelled')),
  review_prompted       boolean not null default false,
  created_at            timestamptz not null default now()
);

create index if not exists bookings_status_idx on bookings (status, payment_status);
create index if not exists bookings_slot_idx on bookings (slot_start);

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
