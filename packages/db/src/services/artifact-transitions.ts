/**
 * Artifact lifecycle state machine (spec §12.2) encoded as DATA, over the full
 * state set declared authoritative by PATCH-SET-01 §E2. Transcribed verbatim
 * from §12.2:
 *
 *   draft                -> in_review, superseded
 *   in_review            -> approved, approved_with_edits, rejected, deferred,
 *                           draft (through requested revision)
 *   approved             -> ready_for_action, superseded
 *   approved_with_edits  -> ready_for_action, superseded
 *   ready_for_action     -> executed, failed, superseded
 *   rejected, deferred, executed, failed, superseded
 *                        -> (terminal; §12.2 lists no outgoing edges)
 *
 * 10 states, 14 legal edges. Any (from, to) pair not listed here — including
 * self-transitions, which §12.2 never lists — is illegal.
 *
 * NOTE on terminal states (surfaced per the build instruction): §12.2 lists no
 * outgoing edges for `rejected` or `deferred`, so this literal transcription
 * treats them as terminal. In a fuller model one might expect
 * `rejected/deferred -> draft` (re-open), but §12.2 routes revision only via
 * `in_review -> draft`. We encode exactly what §12.2 states; re-opening a
 * terminal artifact is out of scope for this slice.
 */
export const ARTIFACT_STATUSES = [
  "draft",
  "in_review",
  "approved",
  "approved_with_edits",
  "rejected",
  "deferred",
  "ready_for_action",
  "executed",
  "failed",
  "superseded",
] as const;

export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

export const ARTIFACT_TRANSITIONS: Record<ArtifactStatus, readonly ArtifactStatus[]> = {
  draft: ["in_review", "superseded"],
  in_review: ["approved", "approved_with_edits", "rejected", "deferred", "draft"],
  approved: ["ready_for_action", "superseded"],
  approved_with_edits: ["ready_for_action", "superseded"],
  rejected: [],
  deferred: [],
  ready_for_action: ["executed", "failed", "superseded"],
  executed: [],
  failed: [],
  superseded: [],
};

export function isLegalArtifactTransition(from: ArtifactStatus, to: ArtifactStatus): boolean {
  return ARTIFACT_TRANSITIONS[from].includes(to);
}

/** Every legal (from, to) edge — used by tests to cover 100% of the matrix. */
export const LEGAL_ARTIFACT_EDGES: Array<[ArtifactStatus, ArtifactStatus]> =
  ARTIFACT_STATUSES.flatMap((from) =>
    ARTIFACT_TRANSITIONS[from].map((to) => [from, to] as [ArtifactStatus, ArtifactStatus]),
  );

/** Every (from, to) pair NOT in the legal set, including self-transitions. */
export const ILLEGAL_ARTIFACT_EDGES: Array<[ArtifactStatus, ArtifactStatus]> =
  ARTIFACT_STATUSES.flatMap((from) =>
    ARTIFACT_STATUSES.filter((to) => !isLegalArtifactTransition(from, to)).map(
      (to) => [from, to] as [ArtifactStatus, ArtifactStatus],
    ),
  );
