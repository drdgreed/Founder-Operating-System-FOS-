CREATE TABLE "objection_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"source_interaction_id" uuid,
	"category" text NOT NULL,
	"statement" text NOT NULL,
	"classification" text NOT NULL,
	"confidence" text,
	"severity" text,
	"resolution_status" text DEFAULT 'open' NOT NULL,
	"resolution_summary" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "objection_record_resolution_status_valid" CHECK ("objection_record"."resolution_status" IN ('open', 'addressed', 'withdrawn', 'unresolved'))
);
--> statement-breakpoint
CREATE TABLE "enrollment_action_recommendation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"agent_run_id" uuid,
	"action_type" text NOT NULL,
	"summary" text NOT NULL,
	"rationale" text,
	"business_impact" text,
	"urgency" text,
	"confidence" text,
	"recommended_due_at" timestamp with time zone,
	"artifact_record_id" uuid,
	"status" text DEFAULT 'proposed' NOT NULL,
	"outcome" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enrollment_action_recommendation_status_valid" CHECK ("enrollment_action_recommendation"."status" IN ('proposed', 'accepted', 'dismissed', 'actioned', 'expired'))
);
--> statement-breakpoint
ALTER TABLE "objection_record" ADD CONSTRAINT "objection_record_workspace_id_fos_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fos_workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objection_record" ADD CONSTRAINT "objection_record_opportunity_id_enrollment_opportunity_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."enrollment_opportunity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objection_record" ADD CONSTRAINT "objection_record_source_interaction_id_interaction_id_fk" FOREIGN KEY ("source_interaction_id") REFERENCES "public"."interaction"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_action_recommendation" ADD CONSTRAINT "enrollment_action_recommendation_workspace_id_fos_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fos_workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_action_recommendation" ADD CONSTRAINT "enrollment_action_recommendation_opportunity_id_enrollment_opportunity_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."enrollment_opportunity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_action_recommendation" ADD CONSTRAINT "enrollment_action_recommendation_agent_run_id_agent_run_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_action_recommendation" ADD CONSTRAINT "enrollment_action_recommendation_artifact_record_id_artifact_record_id_fk" FOREIGN KEY ("artifact_record_id") REFERENCES "public"."artifact_record"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "objection_record_workspace_id_idx" ON "objection_record" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "objection_record_opportunity_id_idx" ON "objection_record" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX "objection_record_source_interaction_id_idx" ON "objection_record" USING btree ("source_interaction_id");--> statement-breakpoint
CREATE INDEX "enrollment_action_recommendation_workspace_id_idx" ON "enrollment_action_recommendation" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "enrollment_action_recommendation_opportunity_id_idx" ON "enrollment_action_recommendation" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX "enrollment_action_recommendation_agent_run_id_idx" ON "enrollment_action_recommendation" USING btree ("agent_run_id");--> statement-breakpoint
CREATE INDEX "enrollment_action_recommendation_artifact_record_id_idx" ON "enrollment_action_recommendation" USING btree ("artifact_record_id");