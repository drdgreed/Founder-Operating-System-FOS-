import { eq, and } from "drizzle-orm";
import { interaction } from "../schema/interaction.js";
import type { Db } from "./types.js";

export type InteractionRow = typeof interaction.$inferSelect;

export class InteractionNotFoundError extends Error {
  constructor(interactionId: string) {
    super(`Interaction ${interactionId} not found`);
    this.name = "InteractionNotFoundError";
  }
}

export class StaleInteractionVersionError extends Error {
  constructor(
    public readonly expectedVersion: number,
    public readonly actualVersion: number,
  ) {
    super(
      `Stale interaction version: expected ${expectedVersion}, current version is ${actualVersion}`,
    );
    this.name = "StaleInteractionVersionError";
  }
}

export interface CreateInteractionInput {
  workspaceId: string;
  opportunityId: string;
  interactionType: string;
  status?: string;
  scheduledAt?: Date | null;
  occurredAt?: Date | null;
  notes?: string | null;
  transcriptRef?: string | null;
}

/**
 * Creates one Interaction row (issue #56 P1.3a) at `version = 1`. Unlike
 * `enrollment_assessment`, this is a mutable lifecycle record, not
 * append-only — subsequent status changes go through
 * `updateInteractionStatus` rather than inserting a new row.
 */
export async function createInteraction(
  db: Db,
  input: CreateInteractionInput,
): Promise<InteractionRow> {
  const [row] = await db
    .insert(interaction)
    .values({
      workspaceId: input.workspaceId,
      opportunityId: input.opportunityId,
      interactionType: input.interactionType,
      ...(input.status !== undefined ? { status: input.status } : {}),
      scheduledAt: input.scheduledAt ?? null,
      occurredAt: input.occurredAt ?? null,
      notes: input.notes ?? null,
      transcriptRef: input.transcriptRef ?? null,
    })
    .returning();
  if (!row) throw new Error("createInteraction: interaction insert returned no row");
  return row;
}

/**
 * Workspace-scoped read (spec §10: all `/interactions/*` reads require
 * workspace authorization). Returns `null` both when the id doesn't exist
 * AND when it exists under a different workspace — a caller cannot
 * distinguish "not found" from "not yours", which is the point: no
 * cross-workspace existence leak. FLAG: issue #56 left the exact
 * not-found/cross-tenant behavior open ("reject/so return-null"); a
 * thrown `InteractionNotFoundError` variant can be layered at the API
 * boundary in P1.3b if that surface wants a distinct 404 vs 403.
 */
export async function getInteractionById(
  db: Db,
  workspaceId: string,
  interactionId: string,
): Promise<InteractionRow | null> {
  const [row] = await db
    .select()
    .from(interaction)
    .where(and(eq(interaction.id, interactionId), eq(interaction.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

export interface UpdateInteractionStatusInput {
  interactionId: string;
  expectedVersion: number;
  status: string;
  occurredAt?: Date | null;
}

/**
 * Updates `status` (and optionally `occurred_at`) on an existing
 * Interaction, bumping `version` by one. Optimistic-concurrency guard
 * mirrors `transitionOpportunity`: a stale `expectedVersion` throws
 * `StaleInteractionVersionError` and writes nothing.
 */
export async function updateInteractionStatus(
  db: Db,
  input: UpdateInteractionStatusInput,
): Promise<InteractionRow> {
  return db.transaction(async (tx: Db) => {
    const [current] = await tx
      .select()
      .from(interaction)
      .where(eq(interaction.id, input.interactionId))
      .limit(1);

    if (!current) {
      throw new InteractionNotFoundError(input.interactionId);
    }
    if (current.version !== input.expectedVersion) {
      throw new StaleInteractionVersionError(input.expectedVersion, current.version);
    }

    const update: Record<string, unknown> = {
      status: input.status,
      version: current.version + 1,
      updatedAt: new Date(),
    };
    if (input.occurredAt !== undefined) {
      update.occurredAt = input.occurredAt;
    }

    const updated = await tx
      .update(interaction)
      .set(update)
      .where(
        and(
          eq(interaction.id, input.interactionId),
          eq(interaction.version, input.expectedVersion),
        ),
      )
      .returning();

    if (updated.length === 0) {
      // Concurrent writer won the race between our SELECT and this UPDATE.
      // Re-read to report the TRUE current version — `current.version` was
      // asserted equal to `expectedVersion` above, so reporting it here would
      // give a misleading "expected N, current N" (mirrored in
      // opportunity-transition-service — issue #58).
      const [latest] = await tx
        .select({ version: interaction.version })
        .from(interaction)
        .where(eq(interaction.id, input.interactionId))
        .limit(1);
      throw new StaleInteractionVersionError(
        input.expectedVersion,
        latest?.version ?? current.version,
      );
    }
    const [row] = updated;
    if (!row) throw new Error("updateInteractionStatus: interaction update returned no row");
    return row;
  });
}
