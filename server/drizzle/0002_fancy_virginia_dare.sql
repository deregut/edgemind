ALTER TABLE "conversations" ADD COLUMN "todos" jsonb;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "upload_id" text;--> statement-breakpoint
ALTER TABLE "tool_approvals" ADD COLUMN "kind" text DEFAULT 'approval' NOT NULL;--> statement-breakpoint
ALTER TABLE "tool_approvals" ADD COLUMN "answer" jsonb;