import { createHash } from "node:crypto";
import { APPLICATION_SUBMISSION_INTAKE_IDEMPOTENCY_KEY_CONSTRAINT } from "../schema/application_submission.js";

/**
 * `intake_idempotency_key` derivation (PATCH-SET-01 §S3):
 *
 *   SHA-256(integration_id + ':' + external_application_ref)
 *     when the provider supplies a stable ref;
 *   else SHA-256(product_id + ':' + person_natural_key)
 *
 * §S3 does not define `person_natural_key`. This slice defines it as the
 * normalized (trimmed, lower-cased) email when present, else a lower-cased
 * `firstName|lastName|phone` composite. DEVIATION — see slice report.
 */
export interface DeriveIntakeIdempotencyKeyInput {
  integrationId?: string | null;
  externalApplicationRef?: string | null;
  productId: string;
  personNaturalKey: string;
}

export function deriveIntakeIdempotencyKey(input: DeriveIntakeIdempotencyKeyInput): string {
  const basis =
    input.integrationId && input.externalApplicationRef
      ? `${input.integrationId}:${input.externalApplicationRef}`
      : `${input.productId}:${input.personNaturalKey}`;
  return createHash("sha256").update(basis).digest("hex");
}

export function normalizePersonNaturalKey(person: {
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
}): string {
  if (person.email) {
    return person.email.trim().toLowerCase();
  }
  return `${person.firstName}|${person.lastName}|${person.phone ?? ""}`.trim().toLowerCase();
}

/**
 * Detects a Postgres unique-violation (SQLSTATE 23505) on the
 * `intake_idempotency_key` constraint, thrown when a concurrent duplicate
 * intake races past the service-layer SELECT (issue #5 / SF-4): both
 * transactions miss the pre-insert existence check, and the DB-level unique
 * index rejects the loser. The caller should treat this as a graceful dedupe,
 * not an error.
 *
 * Drizzle wraps driver errors in `DrizzleQueryError` with the original error
 * on `.cause`. The constraint-name field differs across drivers — PGlite
 * (via @electric-sql/pg-protocol, used in tests) exposes `constraint`;
 * postgres-js (production) exposes `constraint_name` — so both are checked.
 */
export function isDuplicateIntakeIdempotencyKeyError(error: unknown): boolean {
  const cause =
    error && typeof error === "object" && "cause" in error
      ? (error as { cause?: unknown }).cause
      : error;
  if (!cause || typeof cause !== "object") return false;
  const driverError = cause as { code?: unknown; constraint?: unknown; constraint_name?: unknown };
  return (
    driverError.code === "23505" &&
    (driverError.constraint === APPLICATION_SUBMISSION_INTAKE_IDEMPOTENCY_KEY_CONSTRAINT ||
      driverError.constraint_name === APPLICATION_SUBMISSION_INTAKE_IDEMPOTENCY_KEY_CONSTRAINT)
  );
}
