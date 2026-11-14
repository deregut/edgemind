CREATE TABLE "secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"value_enc" text NOT NULL,
	"value_preview" text,
	"allowed_domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "secrets_name_uq" ON "secrets" USING btree ("name");