import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { EventActor } from "@fos/contracts";
import { approval, artifactVersion, type approvalRiskLevelEnum } from "../schema/index.js";
import { writeEvent } from "./event-writer.js";
import {
  transitionArtifactVersionStatus,
  ArtifactVersionNotFoundError,
} from "./artifact-service.js";
import type { ArtifactStatus } from "./artifact-transitions.js";
import type { Db } from "./types.js";

/**
 * The decidable state for an Approval decision (§12.2): a decision applies only
 * to a version currently `in_review`.
 */
export const DECIDABLE_STATUS = "in_review" as const satisfies ArtifactStatus;

/**
 * Approval decisions this slice records, and the §E2 decision → lifecycle map:
 * the version's `approval_status` takes the decided value. Each target is a
 * legal §12.2 edge out of `in_review`, so the reused
 * `transitionArtifactVersionStatus` drives it and emits the matching granular
 * artifact event (artifact.approved / artifact.rejected / …).
 */
export const APPROVAL_DECISION_TO_STATUS = {
  approved: "approved",
  approved_with_edits: "approved_with_edits",
  rejected: "rejected",
  deferred: "deferred",
} as const satisfies Record<string, ArtifactStatus>;

export type ApprovalDecision = keyof typeof APPROVAL_DECISION_TO_STATUS;
export type ApprovalRiskLevel = (typeof approvalRiskLevelEnum.enumValues)[number];

/** Raised when a decision targets a version that is not in a decidable state. */
export class ArtifactNotDecidableError extends Error {
  constructor(
    public readonly versionId: string,
    public readonly actualStatus: ArtifactStatus,
  ) {
    super(
      `ArtifactVersion ${versionId} is not decidable (status ${actualStatus}; decisions apply to '${DECIDABLE_STATUS}')`,
    );
    this.name = "ArtifactNotDecidableError";
  }
}

export interface RecordApprovalDecisionInput {
  artifactVersionId: string;
  decision: ApprovalDecision;
  riskLevel: ApprovalRiskLevel;
  actor: EventActor;
  reason?: string | null;
  /**
   * Optional optimistic-concurrency token forwarded to the reused transition's
   * CAS. Defaults to the decidable state `in_review`; a caller may pass a stale
   * value to force an optimistic rejection (whole decision rolls back).
   */
  expectedStatus?: ArtifactStatus;
}

export interface RecordApprovalDecisionResult {
  approvalId: string;
  artifactVersionId: string;
  artifactId: string;
  decision: ApprovalDecision;
  status: ArtifactStatus;
  approvalEventId: string;
  artifactEventId: string;
}

/**
 * Records a human-gate Approval decision on an ArtifactVersion (§9.14), in ONE
 * transaction:
 *   1. Guard: the version must be decidable (`in_review`, §12.2). Otherwise
 *      reject — no Approval row, no events.
 *   2. Insert the Approval record (the decided value).
 *   3. Drive the version's `approval_status` via the §E2 map by REUSING
 *      `transitionArtifactVersionStatus` (emits the granular artifact event,
 *      syncs the ArtifactRecord.status mirror, CAS-guards on the expected
 *      status). The transition is NOT re-implemented here.
 *   4. Emit `approval.recorded` (see the §9.7/§S1 gap flagged in @fos/contracts).
 *
 * Atomicity: because every step runs in the outer transaction, if the
 * transition throws (illegal/stale) the Approval insert rolls back too.
 *
 * DEFERRED (not implemented; flagged): the §14.5 deterministic claims/consent
 * validation — ProductClaim/consent entities do not exist yet; they wire in a
 * later slice. This slice is decision → lifecycle only.
 */
export async function recordApprovalDecision(
  db: Db,
  input: RecordApprovalDecisionInput,
): Promise<RecordApprovalDecisionResult> {
  return db.transaction(async (tx: Db) => {
    const [version] = await tx
      .select()
      .from(artifactVersion)
      .where(eq(artifactVersion.id, input.artifactVersionId))
      .limit(1);

    if (!version) {
      throw new ArtifactVersionNotFoundError(input.artifactVersionId);
    }

    const currentStatus = version.approvalStatus as ArtifactStatus;
    if (currentStatus !== DECIDABLE_STATUS) {
      throw new ArtifactNotDecidableError(input.artifactVersionId, currentStatus);
    }

    const toStatus = APPROVAL_DECISION_TO_STATUS[input.decision];

    const [approvalRow] = await tx
      .insert(approval)
      .values({
        workspaceId: version.workspaceId,
        artifactVersionId: input.artifactVersionId,
        status: input.decision,
        riskLevel: input.riskLevel,
        decidedBy: input.actor.id,
        decidedAt: new Date(),
        reason: input.reason ?? null,
      })
      .returning();

    // REUSE the 0.1b transition — emits the granular artifact event, syncs the
    // record mirror, and CAS-guards on the expected (decidable) status.
    const transition = await transitionArtifactVersionStatus(tx, {
      versionId: input.artifactVersionId,
      expectedStatus: input.expectedStatus ?? DECIDABLE_STATUS,
      toStatus,
      actor: input.actor,
    });

    const approvalEvent = await writeEvent(tx, {
      workspaceId: version.workspaceId,
      entityType: "Approval",
      entityId: approvalRow.id,
      source: "api",
      correlationId: randomUUID(),
      causationId: transition.eventId,
      actor: input.actor,
      type: "approval.recorded",
      payload: {
        approvalId: approvalRow.id,
        artifactVersionId: input.artifactVersionId,
        decision: input.decision,
        riskLevel: input.riskLevel,
      },
    });

    return {
      approvalId: approvalRow.id,
      artifactVersionId: input.artifactVersionId,
      artifactId: transition.artifactId,
      decision: input.decision,
      status: toStatus,
      approvalEventId: approvalEvent.id,
      artifactEventId: transition.eventId,
    };
  });
}
