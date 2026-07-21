import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "db",
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Cap concurrency for the @fos/db package only (issue #72).
    //
    // The migration-bootstrap tests each spin up a *fresh* in-memory PGlite
    // (WASM Postgres) instance. Under vitest's default full file-parallelism,
    // 20+ of these instances start simultaneously and contend on CPU / memory /
    // startup timeouts, so ~8-10 "migration applies clean on a fresh PGlite
    // instance" tests intermittently fail. Each passes in isolation — the
    // failure is resource contention, not a code defect.
    //
    // Serializing db test files (one file at a time) removes the contention.
    // This is scoped to this package via the root vitest.config projects entry;
    // all other packages keep full parallelism.
    fileParallelism: false,
  },
});
