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
