ALTER TABLE "usage_logs" ADD COLUMN "reasoning_tokens" integer;--> statement-breakpoint
ALTER TABLE "usage_logs" ADD COLUMN "model_id" uuid;--> statement-breakpoint
ALTER TABLE "usage_logs" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
CREATE INDEX "usage_logs_run_idx" ON "usage_logs" USING btree ("run_id");