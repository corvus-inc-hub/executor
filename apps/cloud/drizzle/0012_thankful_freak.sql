CREATE TABLE "oauth_attempt" (
	"attempt_key" varchar(255) NOT NULL,
	"state" varchar(255) NOT NULL,
	"actor_user_id" varchar(255) NOT NULL,
	"organization_id" varchar(255) NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"provider" varchar(255) NOT NULL,
	"integration" varchar(255) NOT NULL,
	"execution_id" varchar(255) NOT NULL,
	"descriptor_hash" varchar(255) NOT NULL,
	"status" varchar(255) NOT NULL,
	"lease_token" varchar(255),
	"lease_expires_at" bigint,
	"authorization_url" text NOT NULL,
	"started_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"completed_at" timestamp,
	"row_id" varchar(255) PRIMARY KEY NOT NULL,
	"tenant" varchar(255) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_credential_intent" (
	"attempt_key" varchar(255) NOT NULL,
	"owner" varchar(255) NOT NULL,
	"integration" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"template" varchar(255) NOT NULL,
	"provider_key" varchar(255) NOT NULL,
	"item_id" text NOT NULL,
	"refresh_item_id" text,
	"oauth_client" varchar(255) NOT NULL,
	"oauth_client_owner" varchar(255) NOT NULL,
	"oauth_token_url" text,
	"identity_label" text,
	"expires_at" bigint,
	"oauth_scope" text,
	"missing_oauth_scopes" json,
	"access_token_hash" varchar(255) NOT NULL,
	"refresh_token_hash" varchar(255),
	"status" varchar(255) NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"stored_at" timestamp,
	"committed_at" timestamp,
	"row_id" varchar(255) PRIMARY KEY NOT NULL,
	"tenant" varchar(255) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "oauth_session" ADD COLUMN "attempt_key" varchar(255);--> statement-breakpoint
ALTER TABLE "oauth_session" ADD COLUMN "actor_user_id" varchar(255);--> statement-breakpoint
ALTER TABLE "oauth_session" ADD COLUMN "workspace_id" varchar(255);--> statement-breakpoint
ALTER TABLE "oauth_session" ADD COLUMN "provider" varchar(255);--> statement-breakpoint
ALTER TABLE "oauth_session" ADD COLUMN "descriptor_hash" varchar(255);--> statement-breakpoint
ALTER TABLE "oauth_session" ADD COLUMN "execution_id" varchar(255);--> statement-breakpoint
ALTER TABLE "oauth_session" ADD COLUMN "correlation_envelope" json;--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_attempt_uidx" ON "oauth_attempt" USING btree ("tenant","attempt_key");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_credential_intent_uidx" ON "oauth_credential_intent" USING btree ("tenant","attempt_key");