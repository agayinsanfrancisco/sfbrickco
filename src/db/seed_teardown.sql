-- ============================================================================
-- SF Brick Company — remove ALL demo seed data (from seed.sql)
-- Leaves real users/orders/bookings untouched.
-- ============================================================================
delete from reviews  where expert_id in (select id from users where telegram_id in (900000001, 900000002, 900000003));
delete from bookings where expert_id in (select id from users where telegram_id in (900000001, 900000002, 900000003));
delete from expert_availability where expert_id in (select id from users where telegram_id in (900000001, 900000002, 900000003));
delete from ledger where ref_type = 'seed';

-- Zero the seeded wallet balances.
update users set balance_cents = 0 where telegram_id in (8524453004, 7200676639);

-- Remove the demo Administrators.
delete from users where telegram_id in (900000001, 900000002, 900000003);
