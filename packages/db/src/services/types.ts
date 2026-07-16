/**
 * Loosely-typed handle for a Drizzle Postgres-dialect database/transaction.
 *
 * Service functions in this slice are exercised at runtime against two
 * different drivers: `drizzle-orm/postgres-js` (apps/api, production) and
 * `drizzle-orm/pglite` (tests, PGlite). Both implement the same Postgres
 * query-builder surface (`select`/`insert`/`update`/`transaction`), but their
 * generic driver/session types differ enough that a precisely-typed alias
 * fights the type checker for no safety benefit in a bounded slice. `any` is
 * used deliberately here — a scoped, documented simplification, not an
 * oversight. DEVIATION — see slice report.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = any;
