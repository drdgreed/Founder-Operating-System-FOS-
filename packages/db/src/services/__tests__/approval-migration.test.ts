import { describe, it, expect } from "vitest";
import { createTestDb } from "./pglite-db.js";
import { approval } from "../../schema/approval.js";

describe("slice 0.1c migration applies clean on empty DB", () => {
  it("FOS0-APV-01: all migrations (incl. the approval table) apply to a fresh PGlite instance; the table is queryable", async () => {
    const { db, close } = await createTestDb();
    try {
      expect(await db.select().from(approval)).toEqual([]);
    } finally {
      await close();
    }
  });
});
