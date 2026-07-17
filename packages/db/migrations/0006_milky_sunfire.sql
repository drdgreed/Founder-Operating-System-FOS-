CREATE TYPE "public"."approval_risk_level" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'approved_with_edits', 'rejected', 'deferred', 'expired', 'superseded');--> statement-breakpoint
CREATE TABLE "approval" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"artifact_version_id" uuid NOT NULL,
	"status" "approval_status" NOT NULL,
	"risk_level" "approval_risk_level" NOT NULL,
	"decided_by" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approval" ADD CONSTRAINT "approval_workspace_id_fos_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fos_workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval" ADD CONSTRAINT "approval_artifact_version_id_artifact_version_id_fk" FOREIGN KEY ("artifact_version_id") REFERENCES "public"."artifact_version"("id") ON DELETE no action ON UPDATE no action;