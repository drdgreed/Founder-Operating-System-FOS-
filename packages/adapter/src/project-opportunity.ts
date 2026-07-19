import { and, eq } from "drizzle-orm";
import { projection } from "@fos/db/schema";
import type { Db } from "@fos/db/services";
import type { NotionClient } from "@fos/notion";
import {
  enrollmentOpportunityToNotionProperties,
  type EnrollmentOpportunityRow,
  type ProjectionSyncStatus,
} from "./enrollment-opportunity-mapper.js";

export interface ProjectOpportunityInput {
  opportunity: EnrollmentOpportunityRow;
  /** Target Notion data source (database) id for the Enrollment Pipeline. */
  dataSourceId: string;
}

export interface ProjectOpportunityResult {
  projectionId: string;
  providerPageId: string;
  syncStatus: ProjectionSyncStatus;
  /** true if this call created the Notion page; false if it updated an existing one. */
  created: boolean;
}

function extractPageId(page: unknown): string {
  if (
    typeof page === "object" &&
    page !== null &&
    "id" in page &&
    typeof (page as { id: unknown }).id === "string"
  ) {
    return (page as { id: string }).id;
  }
  throw new Error("projectOpportunity: Notion createPage response missing a string id");
}

/**
 * Projects one EnrollmentOpportunity to its Notion page (issue #27, slice
 * 0.2b). Upserts on the `projection` table's (workspace_id, entity_type,
 * entity_id, provider) unique index:
 * - no existing row (or one with no `provider_page_id` yet) -> `createPage`,
 *   store the returned page id.
 * - existing row with a `provider_page_id` -> `updatePageProperties` on that
 *   SAME page (no duplicate is ever created).
 *
 * Idempotent on (workspace, entity_type, entity_id): calling this twice for
 * the same opportunity always resolves to the same `provider_page_id`.
 */
export async function projectOpportunity(
  db: Db,
  client: NotionClient,
  input: ProjectOpportunityInput,
): Promise<ProjectOpportunityResult> {
  const { opportunity, dataSourceId } = input;

  const [existing] = await db
    .select()
    .from(projection)
    .where(
      and(
        eq(projection.workspaceId, opportunity.workspaceId),
        eq(projection.entityType, "EnrollmentOpportunity"),
        eq(projection.entityId, opportunity.id),
        eq(projection.provider, "notion"),
      ),
    )
    .limit(1);

  const now = new Date();
  const properties = enrollmentOpportunityToNotionProperties(opportunity, {
    workspaceId: opportunity.workspaceId,
    productId: opportunity.productId,
    syncStatus: "in_sync",
    lastSyncedAt: now,
  });

  let providerPageId: string;
  let created: boolean;
  if (existing?.providerPageId) {
    await client.updatePageProperties(existing.providerPageId, properties);
    providerPageId = existing.providerPageId;
    created = false;
  } else {
    const page = await client.createPage({
      parent: { data_source_id: dataSourceId },
      properties,
    });
    providerPageId = extractPageId(page);
    created = true;
  }

  const [row] = await db
    .insert(projection)
    .values({
      workspaceId: opportunity.workspaceId,
      productId: opportunity.productId,
      entityType: "EnrollmentOpportunity",
      entityId: opportunity.id,
      provider: "notion",
      providerPageId,
      syncStatus: "in_sync",
      fosVersion: opportunity.version,
      lastSyncedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        projection.workspaceId,
        projection.entityType,
        projection.entityId,
        projection.provider,
      ],
      set: {
        providerPageId,
        syncStatus: "in_sync",
        fosVersion: opportunity.version,
        lastSyncedAt: now,
        updatedAt: now,
      },
    })
    .returning();
  if (!row) throw new Error("projectOpportunity: projection upsert returned no row");

  return {
    projectionId: row.id,
    providerPageId,
    syncStatus: row.syncStatus,
    created,
  };
}
