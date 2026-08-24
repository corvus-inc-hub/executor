CREATE TABLE `oauth_attempt` (
	`attempt_key` text NOT NULL,
	`state` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`provider` text NOT NULL,
	`integration` text NOT NULL,
	`execution_id` text NOT NULL,
	`descriptor_hash` text NOT NULL,
	`status` text NOT NULL,
	`lease_token` text,
	`lease_expires_at` integer,
	`authorization_url` text NOT NULL,
	`started_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	`row_id` text PRIMARY KEY NOT NULL,
	`tenant` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_attempt_uidx` ON `oauth_attempt` (`tenant`,`attempt_key`);--> statement-breakpoint
CREATE TABLE `oauth_credential_intent` (
	`attempt_key` text NOT NULL,
	`owner` text NOT NULL,
	`integration` text NOT NULL,
	`name` text NOT NULL,
	`template` text NOT NULL,
	`provider_key` text NOT NULL,
	`item_id` text NOT NULL,
	`refresh_item_id` text,
	`oauth_client` text NOT NULL,
	`oauth_client_owner` text NOT NULL,
	`oauth_token_url` text,
	`identity_label` text,
	`expires_at` integer,
	`oauth_scope` text,
	`missing_oauth_scopes` text,
	`access_token_hash` text NOT NULL,
	`refresh_token_hash` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`stored_at` integer,
	`committed_at` integer,
	`row_id` text PRIMARY KEY NOT NULL,
	`tenant` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_credential_intent_uidx` ON `oauth_credential_intent` (`tenant`,`attempt_key`);--> statement-breakpoint
ALTER TABLE `oauth_session` ADD `attempt_key` text;--> statement-breakpoint
ALTER TABLE `oauth_session` ADD `actor_user_id` text;--> statement-breakpoint
ALTER TABLE `oauth_session` ADD `workspace_id` text;--> statement-breakpoint
ALTER TABLE `oauth_session` ADD `provider` text;--> statement-breakpoint
ALTER TABLE `oauth_session` ADD `descriptor_hash` text;--> statement-breakpoint
ALTER TABLE `oauth_session` ADD `execution_id` text;--> statement-breakpoint
ALTER TABLE `oauth_session` ADD `correlation_envelope` text;