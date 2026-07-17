import { describe, it, expect } from "vitest";
import { createTestDb } from "./pglite-db.js";
import { fosWorkspace } from "../../schema/fos_workspace.js";

describe("migration applies clean on empty DB", () => {
  it("FOS0-CORE-01: applies every migration (incl. the append-only trigger) to a fresh PGlite instance with no errors", async () => {
    const { db, close } = await createTestDb();
    try {
      // Sanity: schema is actually usable after migration (not just "no error thrown").
      const rows = await db.select().from(fosWorkspace);
      expect(rows).toEqual([]);
    } finally {
      await close();
    }
  });
});
