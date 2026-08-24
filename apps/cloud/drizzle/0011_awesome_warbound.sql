CREATE TABLE "oauth_completion_receipt" (
	"attempt_key" varchar(255) NOT NULL,
	"actor_user_id" varchar(255) NOT NULL,
	"organization_id" varchar(255) NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"provider" varchar(255) NOT NULL,
	"execution_id" varchar(255) NOT NULL,
	"status" varchar(255) NOT NULL,
	"result_reference" text NOT NULL,
	"connection_owner" varchar(255) NOT NULL,
	"connection_integration" varchar(255) NOT NULL,
	"connection_name" varchar(255) NOT NULL,
	"connection_address" text NOT NULL,
	"request_hash" varchar(255) NOT NULL,
	"descriptor_hash" varchar(255) NOT NULL,
	"started_at" timestamp NOT NULL,
	"completed_at" timestamp NOT NULL,
	"duration_ms" bigint NOT NULL,
	"created_at" timestamp NOT NULL,
	"row_id" varchar(255) PRIMARY KEY NOT NULL,
	"tenant" varchar(255) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_completion_receipt_uidx" ON "oauth_completion_receipt" USING btree ("tenant","attempt_key");
