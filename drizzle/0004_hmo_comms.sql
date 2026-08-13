CREATE TYPE "public"."contact_kind" AS ENUM('doctor', 'clinic', 'hmo');--> statement-breakpoint
CREATE TYPE "public"."correspondence_status" AS ENUM('draft', 'sent', 'awaiting_reply', 'done', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."flow_type" AS ENUM('prescription_conversion', 'commitment_form', 'general_inquiry');--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"kind" "contact_kind" NOT NULL,
	"name" text NOT NULL,
	"specialty" text,
	"phone" text,
	"email" text,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "correspondence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"flow_type" "flow_type" NOT NULL,
	"status" "correspondence_status" DEFAULT 'draft' NOT NULL,
	"contact_id" uuid,
	"recipient_email" text,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"thread_ref" text,
	"message_ref" text,
	"sent_by_user_id" uuid,
	"sent_at" timestamp with time zone,
	"created_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "correspondence_attachments" (
	"correspondence_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	CONSTRAINT "correspondence_attachments_correspondence_id_document_id_pk" PRIMARY KEY("correspondence_id","document_id")
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correspondence" ADD CONSTRAINT "correspondence_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correspondence" ADD CONSTRAINT "correspondence_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correspondence" ADD CONSTRAINT "correspondence_sent_by_user_id_users_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correspondence" ADD CONSTRAINT "correspondence_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correspondence_attachments" ADD CONSTRAINT "correspondence_attachments_correspondence_id_correspondence_id_fk" FOREIGN KEY ("correspondence_id") REFERENCES "public"."correspondence"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correspondence_attachments" ADD CONSTRAINT "correspondence_attachments_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correspondence_attachments" ADD CONSTRAINT "correspondence_attachments_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_space_kind_name_idx" ON "contacts" USING btree ("space_id","kind","name");--> statement-breakpoint
CREATE INDEX "correspondence_space_status_idx" ON "correspondence" USING btree ("space_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "correspondence_attachments_document_idx" ON "correspondence_attachments" USING btree ("document_id");