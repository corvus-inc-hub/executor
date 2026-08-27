CREATE TABLE "oauth_credential_item" (
	"attempt_key" varchar(255) NOT NULL,
	"item_kind" varchar(255) NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"provider_key" varchar(255) NOT NULL,
	"item_id" text NOT NULL,
	"token_hash" varchar(255) NOT NULL,
	"status" varchar(255) NOT NULL,
	"lease_token" varchar(255),
	"lease_generation" bigint,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"stored_at" timestamp,
	"compensated_at" timestamp,
	"row_id" varchar(255) PRIMARY KEY NOT NULL,
	"tenant" varchar(255) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_exchange_intent" (
	"attempt_key" varchar(255) NOT NULL,
	"state" varchar(255) NOT NULL,
	"provider" varchar(255) NOT NULL,
	"client_slug" varchar(255) NOT NULL,
	"code_hash" varchar(255) NOT NULL,
	"provider_transaction_key" varchar(255) NOT NULL,
	"status" varchar(255) NOT NULL,
	"lease_token" varchar(255),
	"lease_generation" bigint,
	"access_token_hash" varchar(255),
	"refresh_token_hash" varchar(255),
	"started_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"completed_at" timestamp,
	"failure_code" varchar(255),
	"row_id" varchar(255) PRIMARY KEY NOT NULL,
	"tenant" varchar(255) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "oauth_attempt" ADD COLUMN "lease_generation" bigint;--> statement-breakpoint
ALTER TABLE "oauth_completion_receipt" ADD COLUMN "lease_token" varchar(255);--> statement-breakpoint
ALTER TABLE "oauth_completion_receipt" ADD COLUMN "lease_generation" bigint;--> statement-breakpoint
ALTER TABLE "oauth_credential_intent" ADD COLUMN "lease_token" varchar(255);--> statement-breakpoint
ALTER TABLE "oauth_credential_intent" ADD COLUMN "lease_generation" bigint;--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_credential_item_uidx" ON "oauth_credential_item" USING btree ("tenant","attempt_key","item_kind");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_exchange_intent_uidx" ON "oauth_exchange_intent" USING btree ("tenant","attempt_key");