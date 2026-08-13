ALTER TABLE "documents" ADD COLUMN "content_hash" text;--> statement-breakpoint
ALTER TABLE "spaces" ADD COLUMN "ocr_first_page_only" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX "documents_space_hash_idx" ON "documents" USING btree ("space_id","content_hash") WHERE "documents"."content_hash" is not null;