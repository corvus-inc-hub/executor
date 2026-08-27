CREATE TABLE `__new_oauth_attempt` (
	`attempt_key` text NOT NULL,
	`state` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`authenticated_subject_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`provider` text NOT NULL,
	`integration` text NOT NULL,
	`execution_id` text NOT NULL,
	`descriptor_hash` text NOT NULL,
	`status` text NOT NULL,
	`lease_token` text,
	`lease_generation` integer,
	`lease_expires_at` integer,
	`authorization_url` text NOT NULL,
	`started_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	`row_id` text PRIMARY KEY NOT NULL,
	`tenant` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_oauth_attempt` (
	`attempt_key`, `state`, `actor_user_id`, `authenticated_subject_id`, `organization_id`,
	`workspace_id`, `provider`, `integration`, `execution_id`, `descriptor_hash`, `status`,
	`lease_token`, `lease_generation`, `lease_expires_at`, `authorization_url`, `started_at`,
	`updated_at`, `completed_at`, `row_id`, `tenant`
)
SELECT
	`attempt_key`, `state`, `actor_user_id`, `actor_user_id`, `organization_id`,
	`workspace_id`, `provider`, `integration`, `execution_id`, `descriptor_hash`, `status`,
	`lease_token`, `lease_generation`, `lease_expires_at`, `authorization_url`, `started_at`,
	`updated_at`, `completed_at`, `row_id`, `tenant`
FROM `oauth_attempt`;
--> statement-breakpoint
DROP TABLE `oauth_attempt`;
--> statement-breakpoint
ALTER TABLE `__new_oauth_attempt` RENAME TO `oauth_attempt`;
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_attempt_uidx` ON `oauth_attempt` (`tenant`,`attempt_key`);
--> statement-breakpoint
CREATE TABLE `__new_oauth_completion_receipt` (
	`attempt_key` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`authenticated_subject_id` text NOT NULL,
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
	`lease_token` text,
	`lease_generation` integer,
	`created_at` integer NOT NULL,
	`row_id` text PRIMARY KEY NOT NULL,
	`tenant` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_oauth_completion_receipt` (
	`attempt_key`, `actor_user_id`, `authenticated_subject_id`, `organization_id`, `workspace_id`,
	`provider`, `execution_id`, `status`, `result_reference`, `connection_owner`,
	`connection_integration`, `connection_name`, `connection_address`, `request_hash`,
	`descriptor_hash`, `started_at`, `completed_at`, `duration_ms`, `lease_token`,
	`lease_generation`, `created_at`, `row_id`, `tenant`
)
SELECT
	`attempt_key`, `actor_user_id`, `actor_user_id`, `organization_id`, `workspace_id`,
	`provider`, `execution_id`, `status`, `result_reference`, `connection_owner`,
	`connection_integration`, `connection_name`, `connection_address`, `request_hash`,
	`descriptor_hash`, `started_at`, `completed_at`, `duration_ms`, `lease_token`,
	`lease_generation`, `created_at`, `row_id`, `tenant`
FROM `oauth_completion_receipt`;
--> statement-breakpoint
DROP TABLE `oauth_completion_receipt`;
--> statement-breakpoint
ALTER TABLE `__new_oauth_completion_receipt` RENAME TO `oauth_completion_receipt`;
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_completion_receipt_uidx` ON `oauth_completion_receipt` (`tenant`,`attempt_key`);
--> statement-breakpoint
ALTER TABLE `oauth_session` ADD `authenticated_subject_id` text;
