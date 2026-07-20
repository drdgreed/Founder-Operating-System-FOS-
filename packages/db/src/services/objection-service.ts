import { eq, and } from "drizzle-orm";
import { objectionRecord } from "../schema/objection_record.js";
import type { Db } from "./types.js";

export type ObjectionRecordRow = typeof objectionRecord.$inferSelect;

export class ObjectionNotFoundError extends Error {
  constructor(objectionId: string) {
    super(`ObjectionRecord ${objectionId} not found`);
    this.name = "ObjectionNotFoundError";
  }
}

export class StaleObjectionVersionError extends Error {
  constructor(
    public readonly expectedVersion: number,
    public readonly actualVersion: number,
  ) {
    super(
      `Stale objection version: expected ${expectedVersion}, current version is ${actualVersion}`,
    );
    this.name = "StaleObjectionVersionError";
  }
}

export interface CreateObjectionInput {
  workspaceId: string;
  opportunityId: string;
  category: string;
  statement: string;
  classification: string;
  confidence?: string | null;
  severity?: string | null;
  sourceInteractionId?: string | null;
  resolutionStatus?: string;
  resolutionSummary?: string | null;
}

/**
 * Creates one ObjectionRecord row (issue #70 P1.4a) at `version = 1`. Mutable
 * lifecycle record, not append-only — subsequent resolution changes go
 * through `updateObjectionResolution` rather than inserting a new row.
 */
export async function createObjection(
  db: Db,
  input: CreateObjectionInput,
): Promise<ObjectionRecordRow> {
  const [row] = await db
    .insert(objectionRecord)
    .values({
      workspaceId: input.workspaceId,
      opportunityId: input.opportunityId,
      category: input.category,
      statement: input.statement,
      classification: input.classification,
      confidence: input.confidence ?? null,
      severity: input.severity ?? null,
      sourceInteractionId: input.sourceInteractionId ?? null,
      ...(input.resolutionStatus !== undefined ? { resolutionStatus: input.resolutionStatus } : {}),
      resolutionSummary: input.resolutionSummary ?? null,
    })
    .returning();
  if (!row) throw new Error("createObjection: objection_record insert returned no row");
  return row;
}

/**
 * Workspace-scoped read (spec §10: all `/api/fos/objections/*` reads require
 * workspace authorization). Returns `null` both when the id doesn't exist AND
 * when it exists under a different workspace — a caller cannot distinguish
 * "not found" from "not yours" (mirrors `getInteractionById`).
 */
export async function getObjectionById(
  db: Db,
  workspaceId: string,
  objectionId: string,
): Promise<ObjectionRecordRow | null> {
  const [row] = await db
    .select()
    .from(objectionRecord)
    .where(and(eq(objectionRecord.id, objectionId), eq(objectionRecord.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

export interface UpdateObjectionResolutionInput {
  objectionId: string;
  expectedVersion: number;
  resolutionStatus: string;
  resolutionSummary?: string | null;
}

/**
 * Updates `resolution_status` (and optionally `resolution_summary`) on an
 * existing ObjectionRecord, bumping `version` by one. Optimistic-concurrency
 * guard mirrors `updateInteractionStatus`: a stale `expectedVersion` throws
 * `StaleObjectionVersionError` and writes nothing.
 */
export async function updateObjectionResolution(
  db: Db,
  input: UpdateObjectionResolutionInput,
): Promise<ObjectionRecordRow> {
  return db.transaction(async (tx: Db) => {
    const [current] = await tx
      .select()
      .from(objectionRecord)
      .where(eq(objectionRecord.id, input.objectionId))
      .limit(1);

    if (!current) {
      throw new ObjectionNotFoundError(input.objectionId);
    }
    if (current.version !== input.expectedVersion) {
      throw new StaleObjectionVersionError(input.expectedVersion, current.version);
    }

    const update: Record<string, unknown> = {
      resolutionStatus: input.resolutionStatus,
      version: current.version + 1,
      updatedAt: new Date(),
    };
    if (input.resolutionSummary !== undefined) {
      update.resolutionSummary = input.resolutionSummary;
    }

    const updated = await tx
      .update(objectionRecord)
      .set(update)
      .where(
        and(
          eq(objectionRecord.id, input.objectionId),
          eq(objectionRecord.version, input.expectedVersion),
        ),
      )
      .returning();

    if (updated.length === 0) {
      const [latest] = await tx
        .select({ version: objectionRecord.version })
        .from(objectionRecord)
        .where(eq(objectionRecord.id, input.objectionId))
        .limit(1);
      throw new StaleObjectionVersionError(
        input.expectedVersion,
        latest?.version ?? current.version,
      );
    }
    const [row] = updated;
    if (!row) throw new Error("updateObjectionResolution: objection_record update returned no row");
    return row;
  });
}
