CREATE TYPE "public"."workspace_command_provider" AS ENUM('notion');--> statement-breakpoint
CREATE TYPE "public"."workspace_command_source" AS ENUM('notion_reconcile');--> statement-breakpoint
CREATE TYPE "public"."workspace_command_status" AS ENUM('pending');--> statement-breakpoint
CREATE TABLE "workspace_command" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"provider" "workspace_command_provider" NOT NULL,
	"provider_page_id" text NOT NULL,
	"command_type" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"status" "workspace_command_status" DEFAULT 'pending' NOT NULL,
	"source" "workspace_command_source" DEFAULT 'notion_reconcile' NOT NULL,
	"provider_last_edited_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_command" ADD CONSTRAINT "workspace_command_workspace_id_fos_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fos_workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_command_page_edit_unique" ON "workspace_command" USING btree ("provider","provider_page_id","provider_last_edited_at","payload_hash");