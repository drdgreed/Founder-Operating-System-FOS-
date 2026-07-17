import { z } from "zod";
import { and, eq } from "drizzle-orm";
import {
  intakeApplication,
  transitionOpportunity,
  OpportunityNotFoundError,
  IllegalTransitionError,
  StaleVersionError,
  OPPORTUNITY_STAGES,
  type Db,
  type IntakeInput,
} from "@fos/db/services";
import {
  product,
  enrollmentOpportunity,
  personSourceEnum,
  personLifecycleEnum,
} from "@fos/db/schema";
import type { Principal } from "./auth.js";
import { zEnumFromPg } from "./zod-pg.js";

/**
 * Testable cores for the two route handlers. Each takes `(db, principal, ...)`
 * so tests can inject a hermetic PGlite db and a server-derived principal —
 * the routes are thin adapters over these. Every result is a plain
 * `{ status, body }` with a GENERIC error body: field names from Zod are fine,
 * but no internal / DB / stack text ever reaches the client.
 */
export interface HandlerResult {
  status: number;
  body: unknown;
}

// `actor` and `workspaceId` are deliberately ABSENT from these schemas. They
// come from the authenticated principal, never the client body; `z.object`
// strips any such keys an attacker includes (audit-poisoning / tenant-forgery
// defense — proven by FOS0-SEC-05/10).
const personInputSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  preferredName: z.string().nullish(),
  email: z.string().email().nullish(),
  phone: z.string().nullish(),
  currentRole: z.string().nullish(),
  currentCompany: z.string().nullish(),
  location: z.string().nullish(),
  linkedinUrl: z.string().nullish(),
  portfolioUrl: z.string().nullish(),
  source: zEnumFromPg(personSourceEnum.enumValues),
  sourceDetail: z.string().nullish(),
  lifecycleType: zEnumFromPg(personLifecycleEnum.enumValues).optional(),
});

const applicationInputSchema = z.object({
  formVersion: z.string().min(1),
  rawPayloadJson: z.unknown().refine((v) => v !== undefined, { message: "Required" }),
  normalizedPayloadJson: z.unknown().optional(),
  resumeAssetId: z.string().uuid().nullish(),
  linkedinSnapshotAssetId: z.string().uuid().nullish(),
  sourceReference: z.string().min(1),
});

const intakeBodySchema = z.object({
  productId: z.string().uuid(),
  integrationId: z.string().nullish(),
  externalApplicationRef: z.string().nullish(),
  person: personInputSchema,
  application: applicationInputSchema,
});

const transitionBodySchema = z.object({
  to_stage: zEnumFromPg(OPPORTUNITY_STAGES),
  expected_version: z.number().int(),
});

function badBody(error: z.ZodError): HandlerResult {
  return {
    status: 400,
    body: { error: "invalid request body", fields: error.flatten().fieldErrors },
  };
}

export async function handleIntake(
  db: Db,
  principal: Principal,
  rawBody: unknown,
): Promise<HandlerResult> {
  const parsed = intakeBodySchema.safeParse(rawBody);
  if (!parsed.success) return badBody(parsed.error);
  const body = parsed.data;

  // Tenant guard (IDOR): the client-supplied productId must belong to the
  // principal's workspace. Mismatch/none → 403, nothing written.
  const owned = await db
    .select({ id: product.id })
    .from(product)
    .where(and(eq(product.id, body.productId), eq(product.workspaceId, principal.workspaceId)))
    .limit(1);
  if (owned.length === 0) {
    return { status: 403, body: { error: "product not found in workspace" } };
  }

  try {
    const input: IntakeInput = {
      workspaceId: principal.workspaceId, // from principal, never body
      productId: body.productId,
      integrationId: body.integrationId ?? null,
      externalApplicationRef: body.externalApplicationRef ?? null,
      actor: principal.actor, // from principal, never body
      person: body.person,
      application: body.application,
    };
    const result = await intakeApplication(db, input);
    return { status: result.deduped ? 200 : 201, body: result };
  } catch {
    return { status: 500, body: { error: "internal error" } };
  }
}

export async function handleTransition(
  db: Db,
  principal: Principal,
  opportunityId: string,
  rawBody: unknown,
): Promise<HandlerResult> {
  if (!z.string().uuid().safeParse(opportunityId).success) {
    return { status: 400, body: { error: "invalid opportunity id" } };
  }

  const parsed = transitionBodySchema.safeParse(rawBody);
  if (!parsed.success) return badBody(parsed.error);

  // Tenant guard: the target opportunity must belong to the principal's
  // workspace. Cross-tenant access is masked as 404 (do not reveal existence).
  const found = await db
    .select({ workspaceId: enrollmentOpportunity.workspaceId })
    .from(enrollmentOpportunity)
    .where(eq(enrollmentOpportunity.id, opportunityId))
    .limit(1);
  const row = found[0];
  if (!row || row.workspaceId !== principal.workspaceId) {
    return { status: 404, body: { error: "opportunity not found" } };
  }

  try {
    const result = await transitionOpportunity(db, {
      opportunityId,
      toStage: parsed.data.to_stage,
      expectedVersion: parsed.data.expected_version,
      actor: principal.actor, // from principal, never body
    });
    return { status: 200, body: result };
  } catch (err) {
    if (err instanceof StaleVersionError)
      return { status: 409, body: { error: "version conflict" } };
    if (err instanceof IllegalTransitionError)
      return { status: 422, body: { error: "illegal transition" } };
    if (err instanceof OpportunityNotFoundError)
      return { status: 404, body: { error: "opportunity not found" } };
    return { status: 500, body: { error: "internal error" } };
  }
}
