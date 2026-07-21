import { and, desc, eq } from "drizzle-orm";
import {
  projection,
  objectionRecord,
  enrollmentActionRecommendation,
  artifactRecord,
} from "@fos/db/schema";
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

  // --- P1.5b (issue #88): join-backed §7.2 fields. The mapper is PURE, so the
  // caller runs these queries and passes the resolved rows into the ctx. Both
  // are direct workspace-scoped (opportunity.workspaceId) on TOP of the
  // opportunity-id scope — the domain's direct-scoping convention, for authz
  // safety even though opportunity_id alone resolves the workspace transitively.

  // 1) Open objections: objection_record for THIS opportunity whose resolution
  // lifecycle is still 'open'. Ordered by created_at (then id, to break ties)
  // for a deterministic projection.
  const openObjections = await db
    .select({
      category: objectionRecord.category,
      classification: objectionRecord.classification,
      statement: objectionRecord.statement,
      severity: objectionRecord.severity,
    })
    .from(objectionRecord)
    .where(
      and(
        eq(objectionRecord.opportunityId, opportunity.id),
        eq(objectionRecord.workspaceId, opportunity.workspaceId),
        eq(objectionRecord.resolutionStatus, "open"),
      ),
    )
    .orderBy(objectionRecord.createdAt, objectionRecord.id);

  // 2) Pending artifact: artifact_record rows in the human-gate 'in_review'
  // state, reached by joining enrollment_action_recommendation on
  // recommendation.artifact_record_id = artifact_record.id. The INNER join
  // drops recommendations with a NULL artifact_record_id (NULL never matches),
  // so those never reach here and never crash. selectDistinct dedupes the case
  // where several recommendations point to the SAME artifact (identical artifact
  // columns collapse to one row). Ordered by artifact updated_at DESC (most
  // recent first), id as a deterministic tiebreak.
  //
  // FLAG (reviewer sign-off): the "awaiting approval" filter is on
  // artifact_record.status = 'in_review' (the artifact's own human-gate
  // lifecycle state), NOT on recommendation.status. A recommendation can be
  // 'proposed'/'accepted'/etc. independent of whether its artifact is still
  // awaiting human approval; the §7.2 "Pending Artifact" field is about the
  // ARTIFACT's gate, so the artifact's status is the correct filter. Confirm
  // this is the intended semantics.
  const pendingArtifactRows = await db
    .selectDistinct({
      id: artifactRecord.id,
      title: artifactRecord.title,
      artifactType: artifactRecord.artifactType,
      updatedAt: artifactRecord.updatedAt,
    })
    .from(enrollmentActionRecommendation)
    .innerJoin(
      artifactRecord,
      eq(enrollmentActionRecommendation.artifactRecordId, artifactRecord.id),
    )
    .where(
      and(
        eq(enrollmentActionRecommendation.opportunityId, opportunity.id),
        eq(enrollmentActionRecommendation.workspaceId, opportunity.workspaceId),
        eq(artifactRecord.workspaceId, opportunity.workspaceId),
        eq(artifactRecord.status, "in_review"),
      ),
    )
    .orderBy(desc(artifactRecord.updatedAt), artifactRecord.id);

  const firstPending = pendingArtifactRows[0];
  const pendingArtifact = firstPending
    ? {
        id: firstPending.id,
        title: firstPending.title,
        artifactType: firstPending.artifactType,
      }
    : null;

  const now = new Date();
  const properties = enrollmentOpportunityToNotionProperties(opportunity, {
    workspaceId: opportunity.workspaceId,
    productId: opportunity.productId,
    syncStatus: "in_sync",
    lastSyncedAt: now,
    openObjections,
    pendingArtifact,
    pendingArtifactCount: pendingArtifactRows.length,
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
