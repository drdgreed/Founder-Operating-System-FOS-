import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { requireServiceAuth, UnauthorizedError, ServiceUnconfiguredError } from "../lib/auth.js";

const ENV_KEYS = ["FOS_SERVICE_TOKEN", "FOS_SERVICE_WORKSPACE_ID", "FOS_SERVICE_ACTOR_ID"] as const;
const saved: Record<string, string | undefined> = {};

function reqWith(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/fos", { headers });
}

describe("requireServiceAuth (ADR-01 service-account shim)", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.FOS_SERVICE_TOKEN = "s3cr3t-service-token";
    process.env.FOS_SERVICE_WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";
    delete process.env.FOS_SERVICE_ACTOR_ID;
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("FOS0-SEC-01: no Authorization header -> UnauthorizedError (401-class)", () => {
    expect(() => requireServiceAuth(reqWith())).toThrow(UnauthorizedError);
  });

  it("FOS0-SEC-02: wrong token -> UnauthorizedError (401-class)", () => {
    expect(() => requireServiceAuth(reqWith({ authorization: "Bearer not-the-token" }))).toThrow(
      UnauthorizedError,
    );
  });

  it("FOS0-SEC-03: unset FOS_SERVICE_TOKEN -> ServiceUnconfiguredError (503-class, fail closed)", () => {
    delete process.env.FOS_SERVICE_TOKEN;
    // Even a request presenting *some* bearer token must be refused when the
    // service is unconfigured — never authenticate open.
    expect(() =>
      requireServiceAuth(reqWith({ authorization: "Bearer s3cr3t-service-token" })),
    ).toThrow(ServiceUnconfiguredError);
  });

  it("FOS0-SEC-04: valid token -> returns the server-configured system principal", () => {
    const principal = requireServiceAuth(reqWith({ authorization: "Bearer s3cr3t-service-token" }));
    expect(principal.workspaceId).toBe("11111111-1111-1111-1111-111111111111");
    expect(principal.actor).toEqual({ type: "system", id: "service-account" });
  });
});
