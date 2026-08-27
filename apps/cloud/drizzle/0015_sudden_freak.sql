ALTER TABLE "oauth_attempt" ADD COLUMN "authenticated_subject_id" varchar(255);--> statement-breakpoint
UPDATE "oauth_attempt" SET "authenticated_subject_id" = "actor_user_id" WHERE "authenticated_subject_id" IS NULL;--> statement-breakpoint
ALTER TABLE "oauth_attempt" ALTER COLUMN "authenticated_subject_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_completion_receipt" ADD COLUMN "authenticated_subject_id" varchar(255);--> statement-breakpoint
UPDATE "oauth_completion_receipt" SET "authenticated_subject_id" = "actor_user_id" WHERE "authenticated_subject_id" IS NULL;--> statement-breakpoint
ALTER TABLE "oauth_completion_receipt" ALTER COLUMN "authenticated_subject_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_session" ADD COLUMN "authenticated_subject_id" varchar(255);
