ALTER TABLE "mcp_servers" ADD COLUMN "tool_prefix" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "protocol_version" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "server_info" jsonb;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "instructions" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "oauth_state" text;--> statement-breakpoint
ALTER TABLE "mcp_tools" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "mcp_tools" ADD COLUMN "annotations" jsonb;--> statement-breakpoint
ALTER TABLE "mcp_tools" ADD COLUMN "risk_customized" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_prefix_uq" ON "mcp_servers" USING btree ("tool_prefix");--> statement-breakpoint
CREATE INDEX "mcp_servers_oauth_state_idx" ON "mcp_servers" USING btree ("oauth_state");