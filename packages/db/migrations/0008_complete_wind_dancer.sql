CREATE TYPE "public"."workspace_integration_provider" AS ENUM('notion');--> statement-breakpoint
CREATE TYPE "public"."workspace_integration_status" AS ENUM('connected', 'disconnected', 'error');--> statement-breakpoint
CREATE TABLE "workspace_integration" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" "workspace_integration_provider" NOT NULL,
	"provider_workspace_id" text,
	"credential_reference" text NOT NULL,
	"status" "workspace_integration_status" DEFAULT 'disconnected' NOT NULL,
	"connected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_integration" ADD CONSTRAINT "workspace_integration_workspace_id_fos_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fos_workspace"("id") ON DELETE no action ON UPDATE no action;