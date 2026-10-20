CREATE TABLE `relay_agent_activity_rows` (
	`environment_id` text NOT NULL,
	`environment_public_key` text NOT NULL,
	`thread_id` text NOT NULL,
	`state_json` text NOT NULL,
	`updated_at` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `relay_agent_activity_rows_pk` PRIMARY KEY(`environment_id`, `environment_public_key`, `thread_id`)
);
--> statement-breakpoint
CREATE TABLE `relay_delivery_attempts` (
	`id` text PRIMARY KEY,
	`created_at` text NOT NULL,
	`user_id` text,
	`environment_id` text,
	`thread_id` text,
	`device_id` text,
	`kind` text NOT NULL,
	`source_job_id` text,
	`token_suffix` text,
	`apns_status` integer,
	`apns_reason` text,
	`apns_id` text,
	`transport_error` text
);
--> statement-breakpoint
CREATE TABLE `relay_dpop_proofs` (
	`thumbprint` text NOT NULL,
	`jti` text NOT NULL,
	`iat` integer NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `relay_dpop_proofs_pk` PRIMARY KEY(`thumbprint`, `jti`)
);
--> statement-breakpoint
CREATE TABLE `relay_environment_credentials` (
	`credential_id` text PRIMARY KEY,
	`environment_id` text NOT NULL,
	`environment_public_key` text NOT NULL,
	`credential_hash` text NOT NULL,
	`revoked_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `relay_environment_links` (
	`user_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`environment_label` text DEFAULT 'Studio Environment' NOT NULL,
	`environment_public_key` text NOT NULL,
	`endpoint_http_base_url` text NOT NULL,
	`endpoint_ws_base_url` text NOT NULL,
	`endpoint_provider_kind` text NOT NULL,
	`notifications_enabled` integer DEFAULT true NOT NULL,
	`live_activities_enabled` integer DEFAULT true NOT NULL,
	`managed_tunnels_enabled` integer DEFAULT false NOT NULL,
	`hold_webhooks_while_offline` integer DEFAULT false NOT NULL,
	`created_by_device_id` text,
	`revoked_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `relay_environment_links_pk` PRIMARY KEY(`user_id`, `environment_id`)
);
--> statement-breakpoint
CREATE TABLE `relay_live_activities` (
	`user_id` text NOT NULL,
	`device_id` text NOT NULL,
	`activity_push_token` text,
	`remote_start_queued_at` text,
	`remote_started_at` text,
	`ended_at` text,
	`last_aggregate_json` text,
	`last_live_activity_delivery_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `relay_live_activities_pk` PRIMARY KEY(`user_id`, `device_id`)
);
--> statement-breakpoint
CREATE TABLE `relay_managed_endpoint_allocations` (
	`user_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`hostname` text NOT NULL,
	`tunnel_id` text,
	`tunnel_name` text NOT NULL,
	`dns_record_id` text,
	`ready_at` text,
	`recovery_enabled_at` text,
	`recovery_environment_public_key` text,
	`tunnel_released_at` text,
	`origin` text,
	`generation` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `relay_managed_endpoint_allocations_pk` PRIMARY KEY(`user_id`, `environment_id`)
);
--> statement-breakpoint
CREATE TABLE `relay_managed_tunnel_limits` (
	`user_id` text PRIMARY KEY,
	`max_tunnels` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `relay_mobile_devices` (
	`user_id` text NOT NULL,
	`device_id` text NOT NULL,
	`label` text DEFAULT 'iOS device' NOT NULL,
	`platform` text NOT NULL,
	`ios_major_version` integer,
	`android_api_level` integer,
	`app_version` text,
	`bundle_id` text,
	`aps_environment` text,
	`push_token` text,
	`push_to_start_token` text,
	`preferences_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `relay_mobile_devices_pk` PRIMARY KEY(`user_id`, `device_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_relay_agent_activity_rows_updated` ON `relay_agent_activity_rows` (`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_relay_delivery_attempts_environment` ON `relay_delivery_attempts` (`environment_id`,`thread_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_relay_delivery_attempts_source_job` ON `relay_delivery_attempts` (`source_job_id`);--> statement-breakpoint
CREATE INDEX `idx_relay_dpop_proofs_expires_at` ON `relay_dpop_proofs` (`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_relay_environment_credentials_hash` ON `relay_environment_credentials` (`credential_hash`);--> statement-breakpoint
CREATE INDEX `idx_relay_environment_credentials_environment` ON `relay_environment_credentials` (`environment_id`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `idx_relay_environment_credentials_environment_key` ON `relay_environment_credentials` (`environment_id`,`environment_public_key`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `idx_relay_environment_links_environment` ON `relay_environment_links` (`environment_id`,`revoked_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_relay_live_activities_activity_push_token` ON `relay_live_activities` (`activity_push_token`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_relay_managed_endpoint_allocations_hostname` ON `relay_managed_endpoint_allocations` (`hostname`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_relay_managed_endpoint_allocations_tunnel_name` ON `relay_managed_endpoint_allocations` (`tunnel_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_relay_mobile_devices_push_token` ON `relay_mobile_devices` (`push_token`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_relay_mobile_devices_push_to_start_token` ON `relay_mobile_devices` (`push_to_start_token`);