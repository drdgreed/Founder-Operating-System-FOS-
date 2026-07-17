import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";

/**
 * Bound handle for a Drizzle Postgres-dialect database OR transaction.
 *
 * Service functions run against two drivers with identical query-builder
 * surfaces but different session/result generics: `drizzle-orm/postgres-js`
 * (apps/api, production) and `drizzle-orm/pglite` (tests). Only the driver's
 * query-result HKT genuinely differs, so THAT one type parameter stays `any`
 * — but the schema parameters are precise, which restores full
 * `insert(...).values(...)` / `select` type-checking against the canonical
 * schema (the safety the previous `Db = any` erased). `PgTransaction` extends
 * `PgDatabase`, so a `tx` inside `db.transaction(...)` is also a `Db`.
 */
type Schema = typeof import("../schema/index.js");

export type Db = PgDatabase<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- driver HKT differs across postgres-js/pglite; only this param must be loose
  any,
  Schema,
  ExtractTablesWithRelations<Schema>
>;
