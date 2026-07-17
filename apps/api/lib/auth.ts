import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Service-account authentication shim (ADR-01-aligned).
 *
 * Slice 0.1a has no accounts/identity model yet. Until the ADR-01 accounts
 * model lands, the API authenticates a single trusted *service caller* via a
 * shared bearer token and binds every request to a server-configured
 * principal. The route handlers are the ONLY trusted callers of the domain
 * services; they must never let a client body dictate who the actor is or
 * which workspace is written to (audit-poisoning / tenant-forgery defense).
 */

export class UnauthorizedError extends Error {
  constructor(message = "unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export class ServiceUnconfiguredError extends Error {
  constructor(message = "service authentication is not configured") {
    super(message);
    this.name = "ServiceUnconfiguredError";
  }
}

export interface Principal {
  workspaceId: string;
  actor: { type: "system"; id: string };
}

/**
 * Constant-time token comparison. Both sides are SHA-256'd first so the
 * comparison is over fixed-length (32-byte) buffers — this avoids
 * `timingSafeEqual` throwing on length mismatch AND avoids leaking the
 * configured token's length via an early length check.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Authenticates a request and returns the server-bound principal.
 *
 * - Fail closed: if `FOS_SERVICE_TOKEN` or `FOS_SERVICE_WORKSPACE_ID` is
 *   unset/empty, throws `ServiceUnconfiguredError` (route → 503). The service
 *   NEVER authenticates while unconfigured.
 * - Missing/malformed `Authorization: Bearer <token>`, or a token that does
 *   not match, throws `UnauthorizedError` (route → 401).
 * - On success, the principal (workspace + actor) comes entirely from server
 *   configuration, never from the request body.
 *
 * Env is read at call time (not module load) so configuration/rotation is
 * picked up without a restart and tests can vary it per case.
 */
export function requireServiceAuth(req: Request): Principal {
  const configuredToken = process.env.FOS_SERVICE_TOKEN;
  const configuredWorkspace = process.env.FOS_SERVICE_WORKSPACE_ID;
  if (!configuredToken || !configuredWorkspace) {
    throw new ServiceUnconfiguredError();
  }

  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) {
    throw new UnauthorizedError();
  }
  const provided = match[1] ?? "";
  if (!constantTimeEquals(provided, configuredToken)) {
    throw new UnauthorizedError();
  }

  return {
    workspaceId: configuredWorkspace,
    // env-bound now; the ADR-01 accounts model replaces this later.
    actor: { type: "system", id: process.env.FOS_SERVICE_ACTOR_ID ?? "service-account" },
  };
}
