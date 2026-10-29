CREATE TABLE `relay_account_deletions` (
	`user_id` text PRIMARY KEY,
	`started_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `relay_connect_accounts` (
	`user_id` text PRIMARY KEY,
	`promo_id` text,
	`founder_number` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `relay_connect_promos` (
	`id` text PRIMARY KEY,
	`seat_cap` integer NOT NULL,
	`seats_granted` integer DEFAULT 0 NOT NULL,
	`founder_tunnel_limit` integer NOT NULL,
	`grants_open` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_relay_connect_accounts_founder_number` ON `relay_connect_accounts` (`promo_id`,`founder_number`);--> statement-breakpoint
-- Founding 1,000: the first 1,000 accounts to link a managed machine get 10 machines.
INSERT INTO `relay_connect_promos` (`id`, `seat_cap`, `seats_granted`, `founder_tunnel_limit`, `grants_open`, `created_at`, `updated_at`) VALUES ('founders', 1000, 0, 10, 1, '2026-10-28T00:00:00.000Z', '2026-10-28T00:00:00.000Z') ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Accounts that already hold a live managed machine linked first, so they take
-- the first founder numbers, in order of their earliest allocation. This also
-- keeps them above the free limit, which drops from 5 to 3 in this release.
INSERT INTO `relay_connect_accounts` (`user_id`, `promo_id`, `founder_number`, `created_at`, `updated_at`)
SELECT `user_id`, 'founders', `rn`, `first_at`, `first_at` FROM (
  SELECT a.`user_id` AS `user_id`, MIN(a.`created_at`) AS `first_at`,
    ROW_NUMBER() OVER (ORDER BY MIN(a.`created_at`), a.`user_id`) AS `rn`
  FROM `relay_managed_endpoint_allocations` a
  JOIN `relay_environment_links` l
    ON l.`user_id` = a.`user_id` AND l.`environment_id` = a.`environment_id`
    AND l.`revoked_at` IS NULL AND l.`managed_tunnels_enabled` = 1
  GROUP BY a.`user_id`
) WHERE `rn` <= (SELECT `seat_cap` FROM `relay_connect_promos` WHERE `id` = 'founders')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE `relay_connect_promos` SET `seats_granted` = (SELECT COUNT(*) FROM `relay_connect_accounts` WHERE `promo_id` = 'founders' AND `founder_number` IS NOT NULL) WHERE `id` = 'founders';
