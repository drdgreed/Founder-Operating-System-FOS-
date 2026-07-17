CREATE TYPE "public"."product_status" AS ENUM('active', 'paused', 'retired');--> statement-breakpoint
CREATE TYPE "public"."product_type" AS ENUM('product', 'sub_offering');--> statement-breakpoint
CREATE TYPE "public"."person_lifecycle_type" AS ENUM('lead', 'applicant', 'beta_user', 'customer', 'partner', 'contact');--> statement-breakpoint
CREATE TYPE "public"."person_privacy_classification" AS ENUM('standard', 'sensitive', 'restricted');--> statement-breakpoint
CREATE TYPE "public"."person_source" AS ENUM('website_application', 'website_lead_form', 'referral', 'linkedin', 'email', 'event', 'webinar', 'manual', 'existing_user', 'other');--> statement-breakpoint
CREATE TYPE "public"."opportunity_stage" AS ENUM('new_lead', 'reviewing', 'contacted', 'conversation_scheduled', 'conversation_completed', 'offered', 'enrolled', 'declined', 'deferred', 'unresponsive', 'disqualified');--> statement-breakpoint
CREATE TYPE "public"."operational_event_actor_type" AS ENUM('founder', 'agent', 'provider', 'system');--> statement-breakpoint
CREATE TABLE "fos_workspace" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"default_timezone" text DEFAULT 'UTC' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"parent_product_id" uuid,
	"product_key" text NOT NULL,
	"name" text NOT NULL,
	"product_type" "product_type" NOT NULL,
	"status" "product_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_type_matches_parent" CHECK (("product"."product_type" = 'product' AND "product"."parent_product_id" IS NULL) OR ("product"."product_type" = 'sub_offering' AND "product"."parent_product_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "person" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"existing_user_id" text,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"preferred_name" text,
	"email" text,
	"phone" text,
	"current_role" text,
	"current_company" text,
	"location" text,
	"linkedin_url" text,
	"portfolio_url" text,
	"source" "person_source" NOT NULL,
	"source_detail" text,
	"lifecycle_type" "person_lifecycle_type" NOT NULL,
	"privacy_classification" "person_privacy_classification" DEFAULT 'standard' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "enrollment_opportunity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"program_id" uuid,
	"cohort_id" uuid,
	"offer_id" uuid,
	"stage" "opportunity_stage" DEFAULT 'new_lead' NOT NULL,
	"status_reason" text,
	"fit_status" text,
	"fit_score" integer,
	"fit_summary" text,
	"estimated_value_cents" integer,
	"currency" text DEFAULT 'USD' NOT NULL,
	"actual_value_cents" integer,
	"primary_goal" text,
	"target_role" text,
	"target_timeline" text,
	"recommended_pathway" text,
	"lead_owner_id" text,
	"last_interaction_at" timestamp with time zone,
	"next_action_type" text,
	"next_action_due_at" timestamp with time zone,
	"next_action_summary" text,
	"closed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_submission" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"form_version" text NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw_payload_json" jsonb NOT NULL,
	"normalized_payload_json" jsonb,
	"resume_asset_id" uuid,
	"linkedin_snapshot_asset_id" uuid,
	"source_reference" text NOT NULL,
	"ingestion_status" text DEFAULT 'received' NOT NULL,
	"ingestion_error" text,
	"intake_idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operational_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"product_id" uuid,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"source" text NOT NULL,
	"correlation_id" uuid NOT NULL,
	"causation_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"actor_type" "operational_event_actor_type" NOT NULL,
	"actor_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_workspace_id_fos_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fos_workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_parent_product_id_product_id_fk" FOREIGN KEY ("parent_product_id") REFERENCES "public"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_workspace_id_fos_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fos_workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_opportunity" ADD CONSTRAINT "enrollment_opportunity_workspace_id_fos_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fos_workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_opportunity" ADD CONSTRAINT "enrollment_opportunity_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_opportunity" ADD CONSTRAINT "enrollment_opportunity_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_submission" ADD CONSTRAINT "application_submission_workspace_id_fos_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fos_workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_submission" ADD CONSTRAINT "application_submission_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_submission" ADD CONSTRAINT "application_submission_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_submission" ADD CONSTRAINT "application_submission_opportunity_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."enrollment_opportunity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational_event" ADD CONSTRAINT "operational_event_workspace_id_fos_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fos_workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational_event" ADD CONSTRAINT "operational_event_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_workspace_key_unique" ON "product" USING btree ("workspace_id","product_key");--> statement-breakpoint
CREATE UNIQUE INDEX "application_submission_intake_idempotency_key_unique" ON "application_submission" USING btree ("intake_idempotency_key");