CREATE TABLE "kb_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_id" uuid NOT NULL,
	"file_id" uuid,
	"name" text NOT NULL,
	"mime" text,
	"size" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'uploading' NOT NULL,
	"error" text,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kb_chunks" DROP CONSTRAINT "kb_chunks_file_id_files_id_fk";
--> statement-breakpoint
ALTER TABLE "kb_chunks" ALTER COLUMN "tsv" DROP EXPRESSION;--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD COLUMN "document_id" uuid;--> statement-breakpoint
ALTER TABLE "kb_collections" ADD COLUMN "requested_dim" integer;--> statement-breakpoint
ALTER TABLE "kb_collections" ADD COLUMN "rerank_provider_id" uuid;--> statement-breakpoint
ALTER TABLE "kb_collections" ADD COLUMN "rerank_model" text;--> statement-breakpoint
ALTER TABLE "kb_collections" ADD COLUMN "chunk_size" integer DEFAULT 1000 NOT NULL;--> statement-breakpoint
ALTER TABLE "kb_collections" ADD COLUMN "chunk_overlap" integer DEFAULT 150 NOT NULL;--> statement-breakpoint
ALTER TABLE "kb_collections" ADD COLUMN "index_error" text;--> statement-breakpoint
ALTER TABLE "kb_collections" ADD COLUMN "index_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "search_tsv" "tsvector";--> statement-breakpoint
ALTER TABLE "kb_documents" ADD CONSTRAINT "kb_documents_collection_id_kb_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."kb_collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_documents" ADD CONSTRAINT "kb_documents_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kb_documents_collection_idx" ON "kb_documents" USING btree ("collection_id");--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_document_id_kb_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."kb_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_collections" ADD CONSTRAINT "kb_collections_rerank_provider_id_providers_id_fk" FOREIGN KEY ("rerank_provider_id") REFERENCES "public"."providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "kb_chunks_document_chunk_uq" ON "kb_chunks" USING btree ("document_id","chunk_index");--> statement-breakpoint
CREATE INDEX "kb_collections_project_idx" ON "kb_collections" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "messages_search_tsv_idx" ON "messages" USING gin ("search_tsv");