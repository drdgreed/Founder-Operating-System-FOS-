import { z } from "zod";

/**
 * @fos/contracts — the single source of truth for cross-boundary schemas
 * (events, entity DTOs, API payloads). Domain entity schemas land with their
 * owning slice; this scaffold establishes the shared OperationalEvent envelope
 * from PATCH-SET-01 §S1.
 */

export const CONTRACTS_VERSION = "0.0.0";

/**
 * Common event envelope carried by every OperationalEvent (PATCH-SET-01 §S1).
 * The envelope is a subset of the persisted row; per-`type` payload schemas are
 * registered alongside their owning slice and validate the `payload` field.
 */
export const eventActorSchema = z.object({
  type: z.enum(["founder", "agent", "provider", "system"]),
  id: z.string().min(1),
});

export const eventEnvelopeSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  product_id: z.string().uuid().nullable().optional(),
  entity_type: z.string().min(1),
  entity_id: z.string().min(1),
  source: z.string().min(1),
  correlation_id: z.string().uuid(),
  causation_id: z.string().uuid().nullable(),
  occurred_at: z.string().datetime(),
  actor: eventActorSchema,
  type: z.string().min(1),
  payload: z.unknown(),
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
export type EventActor = z.infer<typeof eventActorSchema>;

/**
 * S1 payload registry for artifact events (PATCH-SET-02 §C, fulfilling §S1).
 *
 * Maps an artifact event `type` to the Zod schema its `payload` must satisfy.
 * The write path (event writer) validates each event's payload against its
 * registered schema before insert; an unregistered `artifact.*` type is
 * rejected. Only the artifact domain is registered here — event types outside
 * `artifact.*` are governed by their own slices and pass through unchecked.
 */

// The full §12.2 lifecycle state set (PATCH-SET-01 §E2), used to validate the
// from/to fields carried by lifecycle-transition event payloads.
export const artifactLifecycleStatusValues = [
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

const artifactStatusSchema = z.enum(artifactLifecycleStatusValues);

// All lifecycle-transition events share one payload shape (§C).
const artifactLifecyclePayloadSchema = z
  .object({
    artifactId: z.string().uuid(),
    versionId: z.string().uuid(),
    fromStatus: artifactStatusSchema,
    toStatus: artifactStatusSchema,
  })
  .strict();

const artifactCreatedPayloadSchema = z
  .object({
    artifactId: z.string().uuid(),
    versionId: z.string().uuid(),
    artifactType: z.string().min(1),
  })
  .strict();

const artifactVersionCreatedPayloadSchema = z
  .object({
    artifactId: z.string().uuid(),
    versionId: z.string().uuid(),
    versionNumber: z.number().int().positive(),
  })
  .strict();

const artifactDraftEditedPayloadSchema = z
  .object({
    artifactId: z.string().uuid(),
    versionId: z.string().uuid(),
    previousContentHash: z.string().min(1),
    contentHash: z.string().min(1),
  })
  .strict();

/** Registry: artifact event `type` → payload schema (PATCH-SET-02 §A/§C). */
export const ARTIFACT_EVENT_PAYLOAD_SCHEMAS = {
  "artifact.created": artifactCreatedPayloadSchema,
  "artifact.version_created": artifactVersionCreatedPayloadSchema,
  "artifact.draft_edited": artifactDraftEditedPayloadSchema,
  "artifact.approval_requested": artifactLifecyclePayloadSchema,
  "artifact.approved": artifactLifecyclePayloadSchema,
  "artifact.approved_with_edits": artifactLifecyclePayloadSchema,
  "artifact.rejected": artifactLifecyclePayloadSchema,
  "artifact.deferred": artifactLifecyclePayloadSchema,
  "artifact.revision_requested": artifactLifecyclePayloadSchema,
  "artifact.marked_ready": artifactLifecyclePayloadSchema,
  "artifact.executed": artifactLifecyclePayloadSchema,
  "artifact.failed": artifactLifecyclePayloadSchema,
  "artifact.superseded": artifactLifecyclePayloadSchema,
} as const satisfies Record<string, z.ZodTypeAny>;

export type ArtifactEventType = keyof typeof ARTIFACT_EVENT_PAYLOAD_SCHEMAS;

/**
 * Approval event payload registry (slice 0.1c, §S1 discipline).
 *
 * GAP FLAG: spec §9.7 enumerates NO `approval.*` event for the recording of an
 * Approval decision (its approval-related events are all `artifact.*` version
 * lifecycle events). `approval.recorded` is introduced here to give the §9.14
 * decision its own audit event, registered per §S1. This is a §9.7/§S1 gap
 * surfaced for ratification (PATCH-SET-03 candidate), mirroring the 0.1b
 * artifact-taxonomy gap — not an invented business fact.
 */
export const approvalDecisionValues = [
  "approved",
  "approved_with_edits",
  "rejected",
  "deferred",
] as const;

const approvalRecordedPayloadSchema = z
  .object({
    approvalId: z.string().uuid(),
    artifactVersionId: z.string().uuid(),
    decision: z.enum(approvalDecisionValues),
    riskLevel: z.enum(["low", "medium", "high"]),
  })
  .strict();

/** Registry: approval event `type` → payload schema (slice 0.1c). */
export const APPROVAL_EVENT_PAYLOAD_SCHEMAS = {
  "approval.recorded": approvalRecordedPayloadSchema,
} as const satisfies Record<string, z.ZodTypeAny>;

export type ApprovalEventType = keyof typeof APPROVAL_EVENT_PAYLOAD_SCHEMAS;

/**
 * Validates an event `payload` against its registered schema on the write
 * path (PATCH-SET-02 §C / §S1). Registered domains: `artifact.*` and
 * `approval.*`.
 * - unregistered domain prefix → pass (governed by another slice)
 * - registered prefix, no schema for the exact type → throw (unregistered type)
 * - registered type with a malformed payload → throw (ZodError)
 */
export function validateEventPayload(type: string, payload: unknown): void {
  if (type.startsWith("artifact.")) {
    const schema = (ARTIFACT_EVENT_PAYLOAD_SCHEMAS as Record<string, z.ZodTypeAny>)[type];
    if (!schema) {
      throw new Error(`Unregistered artifact event type: ${type}`);
    }
    schema.parse(payload);
    return;
  }
  if (type.startsWith("approval.")) {
    const schema = (APPROVAL_EVENT_PAYLOAD_SCHEMAS as Record<string, z.ZodTypeAny>)[type];
    if (!schema) {
      throw new Error(`Unregistered approval event type: ${type}`);
    }
    schema.parse(payload);
    return;
  }
  // Other domains are not registered here; they pass through until their slice
  // registers schemas.
}
