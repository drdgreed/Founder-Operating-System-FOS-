CREATE TYPE "public"."workspace_command_risk_level" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."workspace_command_status" AS ENUM('received', 'validating', 'validated', 'queued', 'executing', 'succeeded', 'failed_retryable', 'failed_terminal', 'rejected', 'conflict');--> statement-breakpoint
CREATE TABLE "workspace_command" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"workspace_integration_id" uuid,
	"source_provider_record_id" text NOT NULL,
	"source_event_id" text,
	"command_type" text NOT NULL,
	"target_entity_type" text NOT NULL,
	"target_entity_id" text NOT NULL,
	"target_version" integer NOT NULL,
	"payload_json" jsonb NOT NULL,
	"status" "workspace_command_status" DEFAULT 'received' NOT NULL,
	"validation_status" text,
	"execution_status" text,
	"risk_level" "workspace_command_risk_level",
	"rejection_reason" text,
	"correlation_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_command" ADD CONSTRAINT "workspace_command_workspace_id_fos_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fos_workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_command" ADD CONSTRAINT "workspace_command_workspace_integration_id_workspace_integration_id_fk" FOREIGN KEY ("workspace_integration_id") REFERENCES "public"."workspace_integration"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_command_idempotency_key_unique" ON "workspace_command" USING btree ("idempotency_key");