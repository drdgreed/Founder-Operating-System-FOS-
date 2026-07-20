import { eq } from "drizzle-orm";
import { enrollmentAssessment } from "../schema/enrollment_assessment.js";
import type { Db } from "./types.js";

export interface RecordEnrollmentAssessmentInput {
  opportunityId: string;
  agentRunId: string;
  observedFactsJson: unknown;
  inferencesJson: unknown;
  fitStatus: string | null;
  fitConfidence: string | null;
  fitRationale: string | null;
  recommendedPathway: string | null;
  unknownsJson: unknown;
  riskFlagsJson: unknown;
}

export type EnrollmentAssessmentRow = typeof enrollmentAssessment.$inferSelect;

/**
 * Writes one EnrollmentAssessment row (spec §6.4) for an opportunity,
 * auto-incrementing `version` per opportunity (mirrors
 * `createArtifactRevision`'s next-version-number pattern) — each agent run
 * that reassesses the same opportunity appends a new, immutable version
 * rather than overwriting the prior one.
 */
export async function recordEnrollmentAssessment(
  db: Db,
  input: RecordEnrollmentAssessmentInput,
): Promise<EnrollmentAssessmentRow> {
  return db.transaction(async (tx: Db) => {
    const existing = await tx
      .select({ v: enrollmentAssessment.version })
      .from(enrollmentAssessment)
      .where(eq(enrollmentAssessment.opportunityId, input.opportunityId));
    const nextVersion =
      existing.reduce((max: number, r: { v: number }) => Math.max(max, r.v), 0) + 1;

    const [row] = await tx
      .insert(enrollmentAssessment)
      .values({
        opportunityId: input.opportunityId,
        agentRunId: input.agentRunId,
        version: nextVersion,
        observedFactsJson: input.observedFactsJson,
        inferencesJson: input.inferencesJson,
        fitStatus: input.fitStatus,
        fitConfidence: input.fitConfidence,
        fitRationale: input.fitRationale,
        recommendedPathway: input.recommendedPathway,
        unknownsJson: input.unknownsJson,
        riskFlagsJson: input.riskFlagsJson,
      })
      .returning();
    if (!row)
      throw new Error("recordEnrollmentAssessment: enrollment_assessment insert returned no row");
    return row;
  });
}
