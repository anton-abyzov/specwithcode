DROP INDEX IF EXISTS `idx_relay_delivery_attempts_environment`;--> statement-breakpoint
CREATE INDEX `idx_relay_delivery_attempts_created` ON `relay_delivery_attempts` (`created_at`);