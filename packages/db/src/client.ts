import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

/**
 * Canonical Postgres client (ADR-02). One connection pool per process.
 * Reads DATABASE_URL (see .env.example / ADR-04 secret handling).
 */
export function createDbClient(connectionString: string = requireDatabaseUrl()) {
  const sql = postgres(connectionString, { max: 10 });
  return { db: drizzle(sql, { schema }), sql };
}

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set (see .env.example).");
  }
  return url;
}

export { schema };
