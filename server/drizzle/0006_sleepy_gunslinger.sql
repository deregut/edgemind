ALTER TABLE "conversations" ADD COLUMN "summary_up_to" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "summary_updated_at" timestamp with time zone;