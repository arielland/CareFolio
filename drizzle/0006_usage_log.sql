CREATE TYPE "public"."log_level" AS ENUM('debug', 'info', 'warn', 'error');--> statement-breakpoint
ALTER TYPE "public"."action_status" ADD VALUE 'ignored';--> statement-breakpoint
CREATE TABLE "app_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"user_id" uuid,
	"level" "log_level" NOT NULL,
	"event" text NOT NULL,
	"module" text,
	"request_id" text,
	"outcome" text,
	"provider" text,
	"operation" text,
	"model" text,
	"tokens_in" integer,
	"tokens_out" integer,
	"cost_usd" numeric(12, 6),
	"duration_ms" integer,
	"status_code" integer,
	"error_type" text,
	"error_message" text,
	"fields" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_log" ADD CONSTRAINT "app_log_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_log" ADD CONSTRAINT "app_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_log_space_created_idx" ON "app_log" USING btree ("space_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "app_log_space_model_idx" ON "app_log" USING btree ("space_id","created_at" DESC NULLS LAST) WHERE "app_log"."model" is not null;