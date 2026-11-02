-- The founders offer is the first 300 accounts, not 1,000. Only the cap changes:
-- seats_granted, founder numbers and the 10 machine limit stay as they are.
UPDATE `relay_connect_promos` SET `seat_cap` = 300, `updated_at` = '2026-11-02T12:00:00.000Z' WHERE `id` = 'founders';
