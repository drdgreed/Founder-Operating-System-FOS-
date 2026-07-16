import { createDbClient } from "@fos/db";

/**
 * Process-lifetime singleton connection pool. `createDbClient` opens a new
 * `postgres-js` pool (max 10) per call; a serverless/edge route handler must
 * not open a fresh pool on every request, so it is memoized here instead.
 */
let cached: ReturnType<typeof createDbClient> | undefined;

export function getDb() {
  cached ??= createDbClient();
  return cached.db;
}
