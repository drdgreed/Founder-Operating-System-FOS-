import { describe, it, expect } from "vitest";
import { isDuplicateIntakeIdempotencyKeyError } from "../idempotency.js";
import { APPLICATION_SUBMISSION_INTAKE_IDEMPOTENCY_KEY_CONSTRAINT } from "../../schema/application_submission.js";

describe("isDuplicateIntakeIdempotencyKeyError (issue #5 / SF-4)", () => {
  it("FOS0-CORE-08: recognizes a PGlite-shaped 23505 on the intake_idempotency_key constraint", () => {
    const error = {
      message: "Failed query",
      cause: {
        code: "23505",
        constraint: APPLICATION_SUBMISSION_INTAKE_IDEMPOTENCY_KEY_CONSTRAINT,
      },
    };
    expect(isDuplicateIntakeIdempotencyKeyError(error)).toBe(true);
  });

  it("FOS0-CORE-09: recognizes a postgres-js-shaped 23505 (constraint_name field) on the same constraint", () => {
    const error = {
      message: "Failed query",
      cause: {
        code: "23505",
        constraint_name: APPLICATION_SUBMISSION_INTAKE_IDEMPOTENCY_KEY_CONSTRAINT,
      },
    };
    expect(isDuplicateIntakeIdempotencyKeyError(error)).toBe(true);
  });

  it("FOS0-CORE-10: does NOT match a unique violation on a different constraint", () => {
    const error = { cause: { code: "23505", constraint: "some_other_table_unique" } };
    expect(isDuplicateIntakeIdempotencyKeyError(error)).toBe(false);
  });

  it("FOS0-CORE-11: does NOT match a non-unique-violation error code (e.g. FK violation) on the same constraint name", () => {
    const error = {
      cause: {
        code: "23503",
        constraint: APPLICATION_SUBMISSION_INTAKE_IDEMPOTENCY_KEY_CONSTRAINT,
      },
    };
    expect(isDuplicateIntakeIdempotencyKeyError(error)).toBe(false);
  });

  it("FOS0-CORE-12: does NOT match a plain application Error with no driver cause", () => {
    expect(
      isDuplicateIntakeIdempotencyKeyError(new Error("intake: person insert returned no row")),
    ).toBe(false);
  });

  it("FOS0-CORE-13: does NOT match non-error inputs", () => {
    expect(isDuplicateIntakeIdempotencyKeyError(null)).toBe(false);
    expect(isDuplicateIntakeIdempotencyKeyError(undefined)).toBe(false);
    expect(isDuplicateIntakeIdempotencyKeyError("some string")).toBe(false);
  });
});
