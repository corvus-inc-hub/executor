CREATE TABLE `oauth_completion_receipt` (
	`attempt_key` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`provider` text NOT NULL,
	`execution_id` text NOT NULL,
	`status` text NOT NULL,
	`result_reference` text NOT NULL,
	`connection_owner` text NOT NULL,
	`connection_integration` text NOT NULL,
	`connection_name` text NOT NULL,
	`connection_address` text NOT NULL,
	`request_hash` text NOT NULL,
	`descriptor_hash` text NOT NULL,
	`started_at` integer NOT NULL,
	`completed_at` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`created_at` integer NOT NULL,
	`row_id` text PRIMARY KEY NOT NULL,
	`tenant` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_completion_receipt_uidx` ON `oauth_completion_receipt` (`tenant`,`attempt_key`);