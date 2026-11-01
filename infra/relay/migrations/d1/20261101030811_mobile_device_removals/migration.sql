CREATE TABLE `relay_client_keys` (
	`user_id` text NOT NULL,
	`proof_key_thumbprint` text NOT NULL,
	`client_id` text NOT NULL,
	`device_id` text,
	`clerk_session_id` text,
	`last_seen_at` text NOT NULL,
	CONSTRAINT `relay_client_keys_pk` PRIMARY KEY(`user_id`, `proof_key_thumbprint`)
);
--> statement-breakpoint
CREATE TABLE `relay_mobile_device_removals` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`device_id` text,
	`proof_key_thumbprint` text,
	`clerk_session_id` text,
	`label` text,
	`removed_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `relay_mobile_devices` ADD `proof_key_thumbprint` text;--> statement-breakpoint
ALTER TABLE `relay_mobile_devices` ADD `clerk_session_id` text;--> statement-breakpoint
ALTER TABLE `relay_mobile_devices` ADD `model` text;--> statement-breakpoint
ALTER TABLE `relay_mobile_devices` ADD `last_seen_at` text;--> statement-breakpoint
CREATE INDEX `idx_relay_client_keys_device` ON `relay_client_keys` (`user_id`,`device_id`);--> statement-breakpoint
CREATE INDEX `idx_relay_mobile_device_removals_device` ON `relay_mobile_device_removals` (`user_id`,`device_id`);--> statement-breakpoint
CREATE INDEX `idx_relay_mobile_device_removals_key` ON `relay_mobile_device_removals` (`proof_key_thumbprint`,`user_id`);--> statement-breakpoint
CREATE INDEX `idx_relay_mobile_device_removals_session` ON `relay_mobile_device_removals` (`user_id`,`clerk_session_id`);