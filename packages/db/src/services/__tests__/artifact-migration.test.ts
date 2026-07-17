import { describe, it, expect } from "vitest";
import { createTestDb } from "./pglite-db.js";
import { artifactRecord } from "../../schema/artifact_record.js";
import { artifactVersion } from "../../schema/artifact_version.js";

describe("slice 0.1b migrations apply clean on empty DB", () => {
  it("FOS0-ART-01: all migrations (incl. artifact tables + immutability trigger) apply to a fresh PGlite instance; new tables are queryable", async () => {
    const { db, close } = await createTestDb();
    try {
      expect(await db.select().from(artifactRecord)).toEqual([]);
      expect(await db.select().from(artifactVersion)).toEqual([]);
    } finally {
      await close();
    }
  });
});
