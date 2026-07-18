CREATE TYPE "public"."projection_provider" AS ENUM('notion');--> statement-breakpoint
CREATE TYPE "public"."projection_sync_status" AS ENUM('pending', 'in_sync', 'fos_ahead', 'provider_ahead', 'conflict', 'failed', 'disabled');--> statement-breakpoint
CREATE TABLE "projection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"product_id" uuid,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"provider" "projection_provider" NOT NULL,
	"provider_page_id" text,
	"sync_status" "projection_sync_status" DEFAULT 'pending' NOT NULL,
	"fos_version" bigint NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projection" ADD CONSTRAINT "projection_workspace_id_fos_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."fos_workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projection" ADD CONSTRAINT "projection_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "projection_workspace_entity_provider_unique" ON "projection" USING btree ("workspace_id","entity_type","entity_id","provider");