import { randomUUID } from "node:crypto";
import { eventEnvelopeSchema, type EventActor } from "@fos/contracts";
import { operationalEvent } from "../schema/operational_event.js";
import type { Db } from "./types.js";

/**
 * Append-only event writer (spec §9.7 / PATCH-SET-01 §S1). Every write is
 * validated against the shared `eventEnvelopeSchema` from `@fos/contracts`
 * before insert, and propagates `correlation_id` / `causation_id` as given
 * by the caller (this module does not invent causal relationships — that is
 * a domain-service concern).
 */
export interface WriteEventInput {
  workspaceId: string;
  productId?: string | null;
  entityType: string;
  entityId: string;
  source: string;
  correlationId: string;
  causationId?: string | null;
  occurredAt?: Date;
  actor: EventActor;
  type: string;
  payload: unknown;
}

export interface WrittenEvent {
  id: string;
  correlationId: string;
  causationId: string | null;
  type: string;
  occurredAt: string;
}

export async function writeEvent(db: Db, input: WriteEventInput): Promise<WrittenEvent> {
  const id = randomUUID();
  const occurredAt = (input.occurredAt ?? new Date()).toISOString();

  const envelope = eventEnvelopeSchema.parse({
    id,
    workspace_id: input.workspaceId,
    product_id: input.productId ?? null,
    entity_type: input.entityType,
    entity_id: input.entityId,
    source: input.source,
    correlation_id: input.correlationId,
    causation_id: input.causationId ?? null,
    occurred_at: occurredAt,
    actor: input.actor,
    type: input.type,
    payload: input.payload,
  });

  await db.insert(operationalEvent).values({
    id: envelope.id,
    workspaceId: envelope.workspace_id,
    productId: envelope.product_id ?? null,
    entityType: envelope.entity_type,
    entityId: envelope.entity_id,
    source: envelope.source,
    correlationId: envelope.correlation_id,
    causationId: envelope.causation_id,
    occurredAt: new Date(envelope.occurred_at),
    actorType: envelope.actor.type,
    actorId: envelope.actor.id,
    type: envelope.type,
    payload: envelope.payload,
  });

  return {
    id: envelope.id,
    correlationId: envelope.correlation_id,
    causationId: envelope.causation_id,
    type: envelope.type,
    occurredAt: envelope.occurred_at,
  };
}
