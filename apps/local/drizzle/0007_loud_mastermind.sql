CREATE TABLE `oauth_credential_item` (
	`attempt_key` text NOT NULL,
	`item_kind` text NOT NULL,
	`required` integer DEFAULT true NOT NULL,
	`provider_key` text NOT NULL,
	`item_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`status` text NOT NULL,
	`lease_token` text,
	`lease_generation` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`stored_at` integer,
	`compensated_at` integer,
	`row_id` text PRIMARY KEY NOT NULL,
	`tenant` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_credential_item_uidx` ON `oauth_credential_item` (`tenant`,`attempt_key`,`item_kind`);--> statement-breakpoint
CREATE TABLE `oauth_exchange_intent` (
	`attempt_key` text NOT NULL,
	`state` text NOT NULL,
	`provider` text NOT NULL,
	`client_slug` text NOT NULL,
	`code_hash` text NOT NULL,
	`provider_transaction_key` text NOT NULL,
	`status` text NOT NULL,
	`lease_token` text,
	`lease_generation` integer,
	`access_token_hash` text,
	`refresh_token_hash` text,
	`started_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	`failure_code` text,
	`row_id` text PRIMARY KEY NOT NULL,
	`tenant` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_exchange_intent_uidx` ON `oauth_exchange_intent` (`tenant`,`attempt_key`);--> statement-breakpoint
ALTER TABLE `oauth_attempt` ADD `lease_generation` integer;--> statement-breakpoint
ALTER TABLE `oauth_completion_receipt` ADD `lease_token` text;--> statement-breakpoint
ALTER TABLE `oauth_completion_receipt` ADD `lease_generation` integer;--> statement-breakpoint
ALTER TABLE `oauth_credential_intent` ADD `lease_token` text;--> statement-breakpoint
ALTER TABLE `oauth_credential_intent` ADD `lease_generation` integer;