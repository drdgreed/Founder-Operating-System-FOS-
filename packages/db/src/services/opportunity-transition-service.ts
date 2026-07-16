import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import type { EventActor } from "@fos/contracts";
import { enrollmentOpportunity } from "../schema/enrollment_opportunity.js";
import { writeEvent } from "./event-writer.js";
import { isLegalTransition, type OpportunityStage } from "./opportunity-transitions.js";
import type { Db } from "./types.js";

export class OpportunityNotFoundError extends Error {
  constructor(opportunityId: string) {
    super(`EnrollmentOpportunity ${opportunityId} not found`);
    this.name = "OpportunityNotFoundError";
  }
}

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: OpportunityStage,
    public readonly to: OpportunityStage,
  ) {
    super(`Illegal opportunity transition: ${from} -> ${to} (spec §12.1)`);
    this.name = "IllegalTransitionError";
  }
}

export class StaleVersionError extends Error {
  constructor(
    public readonly expectedVersion: number,
    public readonly actualVersion: number,
  ) {
    super(`Stale version: expected ${expectedVersion}, current version is ${actualVersion}`);
    this.name = "StaleVersionError";
  }
}

export interface TransitionOpportunityInput {
  opportunityId: string;
  toStage: OpportunityStage;
  expectedVersion: number;
  actor: EventActor;
  source?: string;
  causationId?: string | null;
}

export interface TransitionOpportunityResult {
  opportunityId: string;
  fromStage: OpportunityStage;
  toStage: OpportunityStage;
  version: number;
  eventId: string;
}

/**
 * Opportunity transition service (spec §12.1, §15.8
 * `POST /api/fos/opportunities/:opportunityId/transition`).
 *
 * A legal edge (per the §12.1 matrix in `opportunity-transitions.ts`)
 * updates `stage` + bumps `version` (optimistic concurrency) and emits
 * exactly one `opportunity.stage_changed` event. An illegal edge, or a
 * stale-`version` request, throws and writes/emits NOTHING.
 */
export async function transitionOpportunity(
  db: Db,
  input: TransitionOpportunityInput,
): Promise<TransitionOpportunityResult> {
  return db.transaction(async (tx: Db) => {
    const [current] = await tx
      .select()
      .from(enrollmentOpportunity)
      .where(eq(enrollmentOpportunity.id, input.opportunityId))
      .limit(1);

    if (!current) {
      throw new OpportunityNotFoundError(input.opportunityId);
    }

    if (current.version !== input.expectedVersion) {
      throw new StaleVersionError(input.expectedVersion, current.version);
    }

    const fromStage = current.stage as OpportunityStage;
    if (!isLegalTransition(fromStage, input.toStage)) {
      throw new IllegalTransitionError(fromStage, input.toStage);
    }

    const newVersion = current.version + 1;

    const updated = await tx
      .update(enrollmentOpportunity)
      .set({ stage: input.toStage, version: newVersion, updatedAt: new Date() })
      .where(
        and(
          eq(enrollmentOpportunity.id, input.opportunityId),
          eq(enrollmentOpportunity.version, input.expectedVersion),
        ),
      )
      .returning();

    if (updated.length === 0) {
      // Concurrent writer won the race between our SELECT and this UPDATE.
      throw new StaleVersionError(input.expectedVersion, current.version);
    }

    const event = await writeEvent(tx, {
      workspaceId: current.workspaceId,
      productId: current.productId,
      entityType: "EnrollmentOpportunity",
      entityId: input.opportunityId,
      source: input.source ?? "api",
      correlationId: randomUUID(),
      causationId: input.causationId ?? null,
      actor: input.actor,
      type: "opportunity.stage_changed",
      payload: { from: fromStage, to: input.toStage, version: newVersion },
    });

    return {
      opportunityId: input.opportunityId,
      fromStage,
      toStage: input.toStage,
      version: newVersion,
      eventId: event.id,
    };
  });
}
