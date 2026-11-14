ALTER TABLE "skills" ADD COLUMN "files" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "frontmatter" jsonb DEFAULT '{}'::jsonb NOT NULL;