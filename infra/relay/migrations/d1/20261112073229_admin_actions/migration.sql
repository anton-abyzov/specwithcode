CREATE TABLE `relay_admin_actions` (
	`id` text PRIMARY KEY,
	`owner_user_id` text NOT NULL,
	`action` text NOT NULL,
	`target_user_id` text NOT NULL,
	`target_id` text,
	`target_label` text,
	`before_json` text,
	`after_json` text,
	`outcome` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_relay_admin_actions_created` ON `relay_admin_actions` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_relay_admin_actions_target` ON `relay_admin_actions` (`target_user_id`,`created_at`);