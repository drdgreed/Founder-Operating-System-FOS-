CREATE TYPE "public"."artifact_domain" AS ENUM('enrollment', 'editorial', 'release', 'marketing', 'research');--> statement-breakpoint
CREATE TYPE "public"."artifact_lifecycle_status" AS ENUM('draft', 'in_review', 'approved', 'approved_with_edits', 'rejected', 'deferred', 'ready_for_action', 'executed', 'failed', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."artifact_type" AS ENUM('internal_note', 'enrollment_message', 'call_brief', 'onboarding_plan', 'support_response', 'product_specification', 'research_brief', 'linkedin_post', 'linkedin_carousel_script', 'substack_paper', 'newsletter', 'landing_page_copy', 'email_sequence', 'release_report', 'operating_review', 'post_call_recap', 'initial_response', 'information_request', 'objection_response', 'offer_follow_up', 'no_show_recovery', 'unresponsive_recovery', 'beta_launch_source_brief', 'webinar_package', 'referral_kit');--> statement-breakpoint
CREATE TABLE "artifact_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"product_id" uuid,
	"artifact_type" "artifact_type" NOT NULL,
	"domain" "artifact_domain" NOT NULL,
	"title" text NOT NULL,
	"current_version_id" uuid,
	"status" "artifact_lifecycle_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifact_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"body_markdown" text NOT NULL,
	"content_hash" text NOT NULL,
	"claims_manifest_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"approval_status" "artifact_lifecycle_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artifact_record" ADD CONSTRAINT "artifact_record_workspace_id_fos_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fos_workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_record" ADD CONSTRAINT "artifact_record_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_version" ADD CONSTRAINT "artifact_version_workspace_id_fos_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fos_workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_version" ADD CONSTRAINT "artifact_version_artifact_id_artifact_record_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifact_record"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_version_artifact_id_version_number_unique" ON "artifact_version" USING btree ("artifact_id","version_number");