-- ============================================================================
-- SF Brick Company — demo seed data (idempotent)
--
-- Purpose: populate the bot so you can mimic the real flows end-to-end —
-- multiple Administrators to book, ratings, a repeat customer, and wallet
-- balances. Safe to re-run: it resets only the demo rows it owns.
--
-- Demo Administrators use telegram_ids in the 900000000+ range so they are easy
-- to spot and remove. They are NOT real Telegram accounts, so the bot can't DM
-- them (those sends are caught and ignored) — they exist to populate the UI.
--
-- To remove ALL demo data, run src/db/seed_teardown.sql.
-- ============================================================================

-- 1) Demo Administrators (experts) -------------------------------------------
insert into users (telegram_id, username, full_name, role, active, rate_cents, address) values
  (900000001, 'alex_brick',  'Alex Brick',  'expert', true, 4000, '500 Howard St, San Francisco, CA 94105'),
  (900000002, 'sam_stud',    'Sam Stud',    'expert', true, 5500, '1 Dr Carlton B Goodlett Pl, San Francisco, CA 94102'),
  (900000003, 'robin_plate', 'Robin Plate', 'expert', true, 3500, '900 North Point St, San Francisco, CA 94109')
on conflict (telegram_id) do update
  set username = excluded.username, full_name = excluded.full_name, role = 'expert',
      active = true, rate_cents = excluded.rate_cents, address = excluded.address;

-- Give the existing real expert a rate if it has none (fully bookable).
update users set rate_cents = 4500 where telegram_id = 7638714195 and rate_cents is null;

-- 2) Availability for the demo experts (reset, then set) ----------------------
delete from expert_availability
 where expert_id in (select id from users where telegram_id in (900000001, 900000002, 900000003));

-- Alex: no windows on purpose → offered every slot (always shows when you /book).
-- Sam: Mon–Fri, Afternoon+Evening (13–21).
insert into expert_availability (expert_id, dow, start_hour, end_hour)
select u.id, d.dow, 13, 21
  from users u cross join (values (1),(2),(3),(4),(5)) as d(dow)
 where u.telegram_id = 900000002;

-- Robin: weekend specialist, Sat & Sun 9–21.
insert into expert_availability (expert_id, dow, start_hour, end_hour)
select u.id, d.dow, 9, 21
  from users u cross join (values (0),(6)) as d(dow)
 where u.telegram_id = 900000003;

-- 3) Historical PAID bookings (reset, then insert) ---------------------------
-- Powers the owner repeat-customer report and the star ratings below.
delete from reviews  where expert_id in (select id from users where telegram_id in (900000001, 900000002, 900000003));
delete from bookings where expert_id in (select id from users where telegram_id in (900000001, 900000002, 900000003));

-- Bill Cobb (8524453004) — TWO completed jobs with Alex → a "repeat customer".
insert into bookings (customer_telegram_id, customer_address, expert_id, slot_start, slot_end,
  service_fee_cents, surcharge_cents, surcharge_source, customer_books_ride, total_cents,
  payment_status, status, review_prompted, waiver_accepted_at, created_at)
select 8524453004, '[DEMO] 1200 Folsom St, San Francisco, CA 94103',
       (select id from users where telegram_id = 900000001),
       now() - interval '7 days', now() - interval '7 days' + interval '1 hour',
       4000, 1500, 'manual', false, 5500, 'paid', 'completed', true,
       now() - interval '7 days', now() - interval '7 days';
insert into bookings (customer_telegram_id, customer_address, expert_id, slot_start, slot_end,
  service_fee_cents, surcharge_cents, surcharge_source, customer_books_ride, total_cents,
  payment_status, status, review_prompted, waiver_accepted_at, created_at)
select 8524453004, '[DEMO] 1200 Folsom St, San Francisco, CA 94103',
       (select id from users where telegram_id = 900000001),
       now() - interval '2 days', now() - interval '2 days' + interval '1 hour',
       4000, 0, 'customer_ride', true, 4000, 'paid', 'completed', true,
       now() - interval '2 days', now() - interval '2 days';

-- Luccu (8621244395) — one completed job with Sam.
insert into bookings (customer_telegram_id, customer_address, expert_id, slot_start, slot_end,
  service_fee_cents, surcharge_cents, surcharge_source, customer_books_ride, total_cents,
  payment_status, status, review_prompted, waiver_accepted_at, created_at)
select 8621244395, '[DEMO] 555 Hayes St, San Francisco, CA 94102',
       (select id from users where telegram_id = 900000002),
       now() - interval '3 days', now() - interval '3 days' + interval '1 hour',
       5500, 1500, 'manual', false, 7000, 'paid', 'completed', true,
       now() - interval '3 days', now() - interval '3 days';

-- 4) Reviews → drive the ⭐ ratings shown when a customer picks an Administrator.
insert into reviews (customer_telegram_id, expert_id, rating, comment) values
  (8524453004, (select id from users where telegram_id = 900000001), 5, 'Super helpful, built fast!'),
  (8621244395, (select id from users where telegram_id = 900000001), 4, 'Great work, on time.'),
  (8621244395, (select id from users where telegram_id = 900000002), 5, 'Knows every set by heart.');

-- 5) Wallet balances (so "Pay from balance" is testable) ---------------------
delete from ledger where ref_type = 'seed';
update users set balance_cents = 7500 where telegram_id = 8524453004; -- Bill Cobb
update users set balance_cents = 2000 where telegram_id = 7200676639; -- you (owner/customer)
insert into ledger (telegram_id, delta_cents, kind, ref_type, ref_id, balance_after) values
  (8524453004, 7500, 'adjustment', 'seed', null, 7500),
  (7200676639, 2000, 'adjustment', 'seed', null, 2000);
