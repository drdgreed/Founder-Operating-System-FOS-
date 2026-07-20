import { eq, and } from "drizzle-orm";
import { enrollmentActionRecommendation } from "../schema/enrollment_action_recommendation.js";
import type { Db } from "./types.js";

export type EnrollmentActionRecommendationRow = typeof enrollmentActionRecommendation.$inferSelect;

export class ActionRecommendationNotFoundError extends Error {
  constructor(recommendationId: string) {
    super(`EnrollmentActionRecommendation ${recommendationId} not found`);
    this.name = "ActionRecommendationNotFoundError";
  }
}

export class StaleActionRecommendationVersionError extends Error {
  constructor(
    public readonly expectedVersion: number,
    public readonly actualVersion: number,
  ) {
    super(
      `Stale action recommendation version: expected ${expectedVersion}, current version is ${actualVersion}`,
    );
    this.name = "StaleActionRecommendationVersionError";
  }
}

export interface CreateActionRecommendationInput {
  workspaceId: string;
  opportunityId: string;
  actionType: string;
  summary: string;
  rationale?: string | null;
  businessImpact?: string | null;
  urgency?: string | null;
  confidence?: string | null;
  recommendedDueAt?: Date | null;
  agentRunId?: string | null;
  artifactRecordId?: string | null;
  status?: string;
  outcome?: string | null;
}

/**
 * Creates one EnrollmentActionRecommendation row (issue #70 P1.4a) at
 * `version = 1`. Mutable lifecycle record, not append-only — subsequent
 * status changes go through `updateActionRecommendationStatus` rather than
 * inserting a new row.
 */
export async function createActionRecommendation(
  db: Db,
  input: CreateActionRecommendationInput,
): Promise<EnrollmentActionRecommendationRow> {
  const [row] = await db
    .insert(enrollmentActionRecommendation)
    .values({
      workspaceId: input.workspaceId,
      opportunityId: input.opportunityId,
      actionType: input.actionType,
      summary: input.summary,
      rationale: input.rationale ?? null,
      businessImpact: input.businessImpact ?? null,
      urgency: input.urgency ?? null,
      confidence: input.confidence ?? null,
      recommendedDueAt: input.recommendedDueAt ?? null,
      agentRunId: input.agentRunId ?? null,
      artifactRecordId: input.artifactRecordId ?? null,
      ...(input.status !== undefined ? { status: input.status } : {}),
      outcome: input.outcome ?? null,
    })
    .returning();
  if (!row) {
    throw new Error(
      "createActionRecommendation: enrollment_action_recommendation insert returned no row",
    );
  }
  return row;
}

/**
 * Workspace-scoped read (spec §10: all reads require workspace
 * authorization). Returns `null` both when the id doesn't exist AND when it
 * exists under a different workspace — a caller cannot distinguish "not
 * found" from "not yours" (mirrors `getInteractionById`/`getObjectionById`).
 */
export async function getActionRecommendationById(
  db: Db,
  workspaceId: string,
  recommendationId: string,
): Promise<EnrollmentActionRecommendationRow | null> {
  const [row] = await db
    .select()
    .from(enrollmentActionRecommendation)
    .where(
      and(
        eq(enrollmentActionRecommendation.id, recommendationId),
        eq(enrollmentActionRecommendation.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export interface UpdateActionRecommendationStatusInput {
  recommendationId: string;
  expectedVersion: number;
  status: string;
  outcome?: string | null;
}

/**
 * Updates `status` (and optionally `outcome`) on an existing
 * EnrollmentActionRecommendation, bumping `version` by one.
 * Optimistic-concurrency guard mirrors `updateInteractionStatus`/
 * `updateObjectionResolution`: a stale `expectedVersion` throws
 * `StaleActionRecommendationVersionError` and writes nothing.
 */
export async function updateActionRecommendationStatus(
  db: Db,
  input: UpdateActionRecommendationStatusInput,
): Promise<EnrollmentActionRecommendationRow> {
  return db.transaction(async (tx: Db) => {
    const [current] = await tx
      .select()
      .from(enrollmentActionRecommendation)
      .where(eq(enrollmentActionRecommendation.id, input.recommendationId))
      .limit(1);

    if (!current) {
      throw new ActionRecommendationNotFoundError(input.recommendationId);
    }
    if (current.version !== input.expectedVersion) {
      throw new StaleActionRecommendationVersionError(input.expectedVersion, current.version);
    }

    const update: Record<string, unknown> = {
      status: input.status,
      version: current.version + 1,
      updatedAt: new Date(),
    };
    if (input.outcome !== undefined) {
      update.outcome = input.outcome;
    }

    const updated = await tx
      .update(enrollmentActionRecommendation)
      .set(update)
      .where(
        and(
          eq(enrollmentActionRecommendation.id, input.recommendationId),
          eq(enrollmentActionRecommendation.version, input.expectedVersion),
        ),
      )
      .returning();

    if (updated.length === 0) {
      const [latest] = await tx
        .select({ version: enrollmentActionRecommendation.version })
        .from(enrollmentActionRecommendation)
        .where(eq(enrollmentActionRecommendation.id, input.recommendationId))
        .limit(1);
      throw new StaleActionRecommendationVersionError(
        input.expectedVersion,
        latest?.version ?? current.version,
      );
    }
    const [row] = updated;
    if (!row) {
      throw new Error(
        "updateActionRecommendationStatus: enrollment_action_recommendation update returned no row",
      );
    }
    return row;
  });
}
