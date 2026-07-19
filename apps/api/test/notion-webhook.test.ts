import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { NotionClient, type FetchLike } from "@fos/notion";
import { person, enrollmentOpportunity, projection, workspaceCommand } from "@fos/db/schema";
import type { Db } from "@fos/db/services";
import type {
  ReconcileInput,
  ReconcileResult,
  CaptureStageCommandsInput,
  CaptureStageCommandsResult,
} from "@fos/adapter";
import { reconcile, captureStageCommands } from "@fos/adapter";
import { handleNotionWebhook, type NotionWebhookConfig } from "../lib/notion-webhook.js";
import { FixedWindowRateLimiter } from "../lib/webhook-rate-limiter.js";
import { createTestDb, seedWorkspaceAndProduct } from "./helpers.js";

const TOKEN_REF = "FOS_TEST_NOTION_WEBHOOK_TOKEN";
const TOKEN = "s3cr3t-webhook-verification-token";

function sign(rawBody: string, token = TOKEN): string {
  return `sha256=${createHmac("sha256", token).update(rawBody).digest("hex")}`;
}

function eventBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "page.properties_updated",
    entity: { id: "page-1", type: "page" },
    data: { updated_properties: ["prop-a"], parent: { id: "ds-config", type: "data_source" } },
    ...overrides,
  });
}

function baseConfig(overrides: Partial<NotionWebhookConfig> = {}): NotionWebhookConfig {
  return {
    workspaceId: "11111111-1111-1111-1111-111111111111",
    dataSourceId: "configured-data-source",
    workspaceIntegrationId: null,
    webhookCredentialReference: TOKEN_REF,
    ...overrides,
  };
}

/**
 * A generous, DEDICATED-per-test limiter — every test that reaches the
 * trigger-check branch gets its own instance so none of them share state
 * (the module's real `defaultTriggerRateLimiter` singleton, or state from
 * another test) via `handleNotionWebhook`'s default. Only the tests that
 * specifically exercise rate-limiting behavior construct their own
 * deliberately-tight limiter instead of calling this.
 */
function freshRateLimiter(): FixedWindowRateLimiter {
  return new FixedWindowRateLimiter({ maxRequests: 1000, windowMs: 60_000 });
}

/** A NotionClient whose underlying fetch throws if it's ever actually called
 * — used to PROVE fetch-latest was NOT triggered (401 / handshake / config
 * failures must never reach the Notion API). */
function unusedNotionClient(): NotionClient {
  const fetchImpl: FetchLike = async () => {
    throw new Error("NotionClient must not be called on this path");
  };
  return new NotionClient({ fetchImpl, requestsPerSecond: 100 });
}

function stubTriggers() {
  const reconcileCalls: ReconcileInput[] = [];
  const captureCalls: CaptureStageCommandsInput[] = [];
  const reconcileFn = async (
    _db: Db,
    _client: NotionClient,
    input: ReconcileInput,
  ): Promise<ReconcileResult> => {
    reconcileCalls.push(input);
    return { pagesProcessed: 0, inSync: 0, conflicts: 0, orphans: 0, duplicateEntityIds: [] };
  };
  const captureStageCommandsFn = async (
    _db: Db,
    _client: NotionClient,
    input: CaptureStageCommandsInput,
  ): Promise<CaptureStageCommandsResult> => {
    captureCalls.push(input);
    return {
      pagesProcessed: 0,
      proposed: 0,
      rejectedIllegalStage: 0,
      unchanged: 0,
      versionConflicts: 0,
      skipped: 0,
      duplicatesDeduped: 0,
    };
  };
  return { reconcileCalls, captureCalls, reconcileFn, captureStageCommandsFn };
}

describe("handleNotionWebhook (issue #39, slice 0.2f — SECURITY-CRITICAL)", () => {
  const savedToken = process.env[TOKEN_REF];

  beforeEach(() => {
    process.env[TOKEN_REF] = TOKEN;
  });

  afterEach(() => {
    if (savedToken === undefined) delete process.env[TOKEN_REF];
    else process.env[TOKEN_REF] = savedToken;
  });

  it("FOS0-WHK-06: valid signature + page.properties_updated event -> fetch-latest triggered, 200", async () => {
    const { reconcileCalls, captureCalls, reconcileFn, captureStageCommandsFn } = stubTriggers();
    const rawBody = eventBody();
    const config = baseConfig();

    const result = await handleNotionWebhook(
      {
        db: {} as Db,
        notionClient: unusedNotionClient(),
        reconcileFn,
        captureStageCommandsFn,
        triggerRateLimiter: freshRateLimiter(),
      },
      config,
      rawBody,
      sign(rawBody),
    );

    expect(result.status).toBe(200);
    expect(reconcileCalls).toHaveLength(1);
    expect(captureCalls).toHaveLength(1);
    expect(reconcileCalls[0]).toEqual({
      workspaceId: config.workspaceId,
      dataSourceId: config.dataSourceId,
    });
    expect(captureCalls[0]).toEqual({
      workspaceId: config.workspaceId,
      dataSourceId: config.dataSourceId,
      workspaceIntegrationId: null,
    });
  });

  it("FOS0-WHK-15: a fetch-latest trigger failure is ack'd 200 (poll loop backstops) with the error surfaced via logError, never an unhandled throw", async () => {
    const { captureCalls, captureStageCommandsFn } = stubTriggers();
    const rawBody = eventBody();
    const config = baseConfig();
    const boom = new Error("reconcile failed (simulated DB fault)");
    const throwingReconcile = async (
      _db: Db,
      _client: NotionClient,
      _input: ReconcileInput,
    ): Promise<ReconcileResult> => {
      throw boom;
    };

    const result = await handleNotionWebhook(
      {
        db: {} as Db,
        notionClient: unusedNotionClient(),
        reconcileFn: throwingReconcile,
        captureStageCommandsFn,
        triggerRateLimiter: freshRateLimiter(),
      },
      config,
      rawBody,
      sign(rawBody),
    );

    // Optimizer failure must NOT become an unhandled 500 or lose the request:
    // ack 200 (poll loop is the authoritative backstop) and surface the error.
    expect(result.status).toBe(200);
    expect(result.logError).toBe(boom);
    // reconcile threw first, so capture never ran.
    expect(captureCalls).toHaveLength(0);
  });

  it("FOS0-WHK-07: invalid signature -> 401, fetch-latest NOT triggered", async () => {
    const { reconcileCalls, captureCalls, reconcileFn, captureStageCommandsFn } = stubTriggers();
    const rawBody = eventBody();

    const result = await handleNotionWebhook(
      { db: {} as Db, notionClient: unusedNotionClient(), reconcileFn, captureStageCommandsFn },
      baseConfig(),
      rawBody,
      sign(rawBody, "wrong-token"),
    );

    expect(result.status).toBe(401);
    expect(reconcileCalls).toHaveLength(0);
    expect(captureCalls).toHaveLength(0);
  });

  it("FOS0-WHK-08: missing signature -> 401, fetch-latest NOT triggered", async () => {
    const { reconcileCalls, captureCalls, reconcileFn, captureStageCommandsFn } = stubTriggers();
    const rawBody = eventBody();

    const result = await handleNotionWebhook(
      { db: {} as Db, notionClient: unusedNotionClient(), reconcileFn, captureStageCommandsFn },
      baseConfig(),
      rawBody,
      null,
    );

    expect(result.status).toBe(401);
    expect(reconcileCalls).toHaveLength(0);
    expect(captureCalls).toHaveLength(0);
  });

  it("FOS0-WHK-09: a verification handshake body -> 200, token surfaced, no fetch-latest triggered (and no signature required)", async () => {
    const { reconcileCalls, captureCalls, reconcileFn, captureStageCommandsFn } = stubTriggers();
    const rawBody = JSON.stringify({ verification_token: "handshake-token-xyz" });

    // Deliberately NO signature header — the handshake has none to give.
    const result = await handleNotionWebhook(
      { db: {} as Db, notionClient: unusedNotionClient(), reconcileFn, captureStageCommandsFn },
      baseConfig(),
      rawBody,
      null,
    );

    expect(result.status).toBe(200);
    expect(JSON.stringify(result.body)).toMatch(/handshake-token-xyz/);
    expect(reconcileCalls).toHaveLength(0);
    expect(captureCalls).toHaveLength(0);
  });

  it("FOS0-WHK-10 (IDs-only): a payload with bogus property VALUES still only triggers a fetch-latest for the CONFIGURED data source — the values are never forwarded", async () => {
    const { reconcileCalls, captureCalls, reconcileFn, captureStageCommandsFn } = stubTriggers();
    const rawBody = eventBody({
      data: {
        updated_properties: [{ id: "prop-a", value: "MALICIOUS_STAGE_VALUE" }],
        parent: { id: "ds-config", type: "data_source" },
      },
    });
    const config = baseConfig();

    const result = await handleNotionWebhook(
      {
        db: {} as Db,
        notionClient: unusedNotionClient(),
        reconcileFn,
        captureStageCommandsFn,
        triggerRateLimiter: freshRateLimiter(),
      },
      config,
      rawBody,
      sign(rawBody),
    );

    expect(result.status).toBe(200);
    // Only ever the CONFIGURED workspace/data source is passed through — the
    // payload's ids/values never leak into the trigger call.
    expect(reconcileCalls).toEqual([
      { workspaceId: config.workspaceId, dataSourceId: config.dataSourceId },
    ]);
    expect(captureCalls).toEqual([
      {
        workspaceId: config.workspaceId,
        dataSourceId: config.dataSourceId,
        workspaceIntegrationId: null,
      },
    ]);
    expect(JSON.stringify(reconcileCalls)).not.toMatch(/MALICIOUS_STAGE_VALUE/);
    expect(JSON.stringify(captureCalls)).not.toMatch(/MALICIOUS_STAGE_VALUE/);
  });

  it("FOS0-WHK-12: unconfigured webhook credential reference -> 503 (fail closed), fetch-latest not triggered", async () => {
    delete process.env[TOKEN_REF];
    const { reconcileCalls, captureCalls, reconcileFn, captureStageCommandsFn } = stubTriggers();
    const rawBody = eventBody();

    const result = await handleNotionWebhook(
      { db: {} as Db, notionClient: unusedNotionClient(), reconcileFn, captureStageCommandsFn },
      baseConfig(),
      rawBody,
      sign(rawBody),
    );

    expect(result.status).toBe(503);
    expect(reconcileCalls).toHaveLength(0);
    expect(captureCalls).toHaveLength(0);
    expect(JSON.stringify(result.body)).not.toMatch(TOKEN);
  });

  it("FOS0-WHK-13: signature valid but workspace/data source unconfigured -> 503, fetch-latest not triggered", async () => {
    const { reconcileCalls, captureCalls, reconcileFn, captureStageCommandsFn } = stubTriggers();
    const rawBody = eventBody();
    const config = baseConfig({ dataSourceId: "" });

    const result = await handleNotionWebhook(
      { db: {} as Db, notionClient: unusedNotionClient(), reconcileFn, captureStageCommandsFn },
      config,
      rawBody,
      sign(rawBody),
    );

    expect(result.status).toBe(503);
    expect(reconcileCalls).toHaveLength(0);
    expect(captureCalls).toHaveLength(0);
  });

  it("FOS0-WHK-14 (SECURITY): the verification_token value never appears in a 401/503 response body or in any thrown error text", async () => {
    const rawBody = eventBody();
    const { reconcileFn, captureStageCommandsFn } = stubTriggers();

    const invalidSigResult = await handleNotionWebhook(
      { db: {} as Db, notionClient: unusedNotionClient(), reconcileFn, captureStageCommandsFn },
      baseConfig(),
      rawBody,
      sign(rawBody, "wrong-token"),
    );
    expect(JSON.stringify(invalidSigResult.body)).not.toMatch(TOKEN);

    delete process.env[TOKEN_REF];
    // handleNotionWebhook never throws (it fails closed with 503) — confirm
    // that AND that the response carries no trace of the token.
    const unconfiguredResult = await handleNotionWebhook(
      { db: {} as Db, notionClient: unusedNotionClient(), reconcileFn, captureStageCommandsFn },
      baseConfig(),
      rawBody,
      sign(rawBody),
    );
    expect(unconfiguredResult.status).toBe(503);
    expect(JSON.stringify(unconfiguredResult.body)).not.toMatch(TOKEN);
  });

  it("FOS0-WHK-16 (issue #41 item 1): a stale event (timestamp past the freshness ceiling) is ack'd 200 without triggering fetch-latest", async () => {
    const { reconcileCalls, captureCalls, reconcileFn, captureStageCommandsFn } = stubTriggers();
    const rawBody = eventBody({ timestamp: "2026-07-19T00:00:00.000Z" });
    const config = baseConfig();
    // "now" is 20 minutes after the event's timestamp — past the 15-minute
    // default ceiling.
    const now = () => Date.parse("2026-07-19T00:20:00.000Z");

    const result = await handleNotionWebhook(
      {
        db: {} as Db,
        notionClient: unusedNotionClient(),
        reconcileFn,
        captureStageCommandsFn,
        now,
      },
      config,
      rawBody,
      sign(rawBody),
    );

    expect(result.status).toBe(200);
    expect(result.skippedReason).toBe("stale-event");
    expect(reconcileCalls).toHaveLength(0);
    expect(captureCalls).toHaveLength(0);
  });

  it("a fresh event (timestamp within the freshness ceiling) triggers fetch-latest normally", async () => {
    const { reconcileCalls, captureCalls, reconcileFn, captureStageCommandsFn } = stubTriggers();
    const rawBody = eventBody({ timestamp: "2026-07-19T00:00:00.000Z" });
    const config = baseConfig();
    // "now" is 5 minutes after the event's timestamp — comfortably fresh.
    const now = () => Date.parse("2026-07-19T00:05:00.000Z");

    const result = await handleNotionWebhook(
      {
        db: {} as Db,
        notionClient: unusedNotionClient(),
        reconcileFn,
        captureStageCommandsFn,
        now,
        triggerRateLimiter: freshRateLimiter(),
      },
      config,
      rawBody,
      sign(rawBody),
    );

    expect(result.status).toBe(200);
    expect(result.skippedReason).toBeUndefined();
    expect(reconcileCalls).toHaveLength(1);
    expect(captureCalls).toHaveLength(1);
  });

  it("an event with NO timestamp is never gated by staleness — it triggers normally regardless of `now`", async () => {
    const { reconcileCalls, captureCalls, reconcileFn, captureStageCommandsFn } = stubTriggers();
    const rawBody = eventBody(); // no `timestamp` field
    const config = baseConfig();
    const now = () => Date.parse("2099-01-01T00:00:00.000Z"); // absurdly "later"

    const result = await handleNotionWebhook(
      {
        db: {} as Db,
        notionClient: unusedNotionClient(),
        reconcileFn,
        captureStageCommandsFn,
        now,
        triggerRateLimiter: freshRateLimiter(),
      },
      config,
      rawBody,
      sign(rawBody),
    );

    expect(result.status).toBe(200);
    expect(result.skippedReason).toBeUndefined();
    expect(reconcileCalls).toHaveLength(1);
  });

  it("a custom maxEventAgeMs is honored", async () => {
    const { reconcileCalls, reconcileFn, captureStageCommandsFn } = stubTriggers();
    const rawBody = eventBody({ timestamp: "2026-07-19T00:00:00.000Z" });
    // Only 1 minute old, but the ceiling is configured to 30 seconds.
    const config = baseConfig({ maxEventAgeMs: 30_000 });
    const now = () => Date.parse("2026-07-19T00:01:00.000Z");

    const result = await handleNotionWebhook(
      {
        db: {} as Db,
        notionClient: unusedNotionClient(),
        reconcileFn,
        captureStageCommandsFn,
        now,
      },
      config,
      rawBody,
      sign(rawBody),
    );

    expect(result.status).toBe(200);
    expect(result.skippedReason).toBe("stale-event");
    expect(reconcileCalls).toHaveLength(0);
  });

  it("FOS0-WHK-17 (issue #41 item 1): once the trigger rate limit is exhausted, further valid events are ack'd 200 without triggering fetch-latest", async () => {
    const { reconcileCalls, captureCalls, reconcileFn, captureStageCommandsFn } = stubTriggers();
    const config = baseConfig();
    const triggerRateLimiter = new FixedWindowRateLimiter({ maxRequests: 1, windowMs: 60_000 });
    const now = () => 0;

    const rawBody1 = eventBody({ entity: { id: "page-a", type: "page" } });
    const first = await handleNotionWebhook(
      {
        db: {} as Db,
        notionClient: unusedNotionClient(),
        reconcileFn,
        captureStageCommandsFn,
        now,
        triggerRateLimiter,
      },
      config,
      rawBody1,
      sign(rawBody1),
    );
    expect(first.status).toBe(200);
    expect(first.skippedReason).toBeUndefined();
    expect(reconcileCalls).toHaveLength(1);

    const rawBody2 = eventBody({ entity: { id: "page-b", type: "page" } });
    const second = await handleNotionWebhook(
      {
        db: {} as Db,
        notionClient: unusedNotionClient(),
        reconcileFn,
        captureStageCommandsFn,
        now,
        triggerRateLimiter,
      },
      config,
      rawBody2,
      sign(rawBody2),
    );
    expect(second.status).toBe(200);
    expect(second.skippedReason).toBe("rate-limited");
    // Still just the one call from the first (allowed) request.
    expect(reconcileCalls).toHaveLength(1);
    expect(captureCalls).toHaveLength(1);
  });

  it("a fresh rate limiter allows a request again once its window has elapsed", async () => {
    const { reconcileCalls, reconcileFn, captureStageCommandsFn } = stubTriggers();
    const config = baseConfig();
    const triggerRateLimiter = new FixedWindowRateLimiter({ maxRequests: 1, windowMs: 1000 });

    const rawBody1 = eventBody({ entity: { id: "page-a", type: "page" } });
    const first = await handleNotionWebhook(
      {
        db: {} as Db,
        notionClient: unusedNotionClient(),
        reconcileFn,
        captureStageCommandsFn,
        now: () => 0,
        triggerRateLimiter,
      },
      config,
      rawBody1,
      sign(rawBody1),
    );
    expect(first.skippedReason).toBeUndefined();

    const rawBody2 = eventBody({ entity: { id: "page-b", type: "page" } });
    const second = await handleNotionWebhook(
      {
        db: {} as Db,
        notionClient: unusedNotionClient(),
        reconcileFn,
        captureStageCommandsFn,
        now: () => 1000, // one full window later
        triggerRateLimiter,
      },
      config,
      rawBody2,
      sign(rawBody2),
    );
    expect(second.skippedReason).toBeUndefined();
    expect(reconcileCalls).toHaveLength(2);
  });
});

describe("handleNotionWebhook idempotency (real reconcile + captureStageCommands, ADR-06 constraint #4)", () => {
  const savedToken = process.env[TOKEN_REF];
  const savedNotionToken = process.env.FOS_NOTION_TOKEN;

  beforeEach(() => {
    process.env[TOKEN_REF] = TOKEN;
    // The real NotionClient (used in this describe block only) resolves its
    // own credential reference independently of the webhook token above.
    process.env.FOS_NOTION_TOKEN = "test-notion-api-token";
  });

  afterEach(() => {
    if (savedToken === undefined) delete process.env[TOKEN_REF];
    else process.env[TOKEN_REF] = savedToken;
    if (savedNotionToken === undefined) delete process.env.FOS_NOTION_TOKEN;
    else process.env.FOS_NOTION_TOKEN = savedNotionToken;
  });

  it("FOS0-WHK-11: a duplicate delivery re-triggers the poll, but it collapses to a safe no-op — no duplicate WorkspaceCommand rows", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace, product } = await seedWorkspaceAndProduct(ctx.db);
      const [personRow] = await ctx.db
        .insert(person)
        .values({
          workspaceId: workspace.id,
          firstName: "Ada",
          lastName: "Lovelace",
          source: "website_application",
          lifecycleType: "applicant",
        })
        .returning();
      const [opportunity] = await ctx.db
        .insert(enrollmentOpportunity)
        .values({
          workspaceId: workspace.id,
          productId: product.id,
          personId: personRow!.id,
          stage: "new_lead",
          currency: "USD",
          version: 1,
        })
        .returning();
      await ctx.db.insert(projection).values({
        workspaceId: workspace.id,
        productId: product.id,
        entityType: "EnrollmentOpportunity",
        entityId: opportunity!.id,
        provider: "notion",
        providerPageId: "notion-page-1",
        syncStatus: "in_sync",
        fosVersion: 1,
        lastSyncedAt: new Date("2026-07-19T12:00:00Z"),
      });

      const cannedPage = {
        id: "notion-page-1",
        last_edited_time: "2026-07-19T13:00:00Z",
        properties: {
          "FOS Record ID": { rich_text: [{ plain_text: opportunity!.id }] },
          "FOS Version": { number: 1 },
          Stage: { select: { name: "reviewing" } },
        },
      };
      const fetchImpl: FetchLike = async (path, init) => {
        const method = init?.method ?? "GET";
        if (method === "POST" && path.includes("/query")) {
          return new Response(
            JSON.stringify({ results: [cannedPage], has_more: false, next_cursor: null }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected call in mock: ${method} ${path}`);
      };
      const notionClient = new NotionClient({ fetchImpl, requestsPerSecond: 100 });

      const config = baseConfig({
        workspaceId: workspace.id,
        dataSourceId: "enrollment-pipeline-ds",
      });
      const rawBody = eventBody();
      const deps = {
        db: ctx.db,
        notionClient,
        reconcileFn: reconcile,
        captureStageCommandsFn: captureStageCommands,
        triggerRateLimiter: freshRateLimiter(),
      };

      const first = await handleNotionWebhook(deps, config, rawBody, sign(rawBody));
      expect(first.status).toBe(200);
      const second = await handleNotionWebhook(deps, config, rawBody, sign(rawBody));
      expect(second.status).toBe(200);

      const commands = await ctx.db
        .select()
        .from(workspaceCommand)
        .where(eq(workspaceCommand.targetEntityId, opportunity!.id));
      expect(commands).toHaveLength(1);
      expect(commands[0]!.status).toBe("received");
    } finally {
      await ctx.close();
    }
    // Heavy integration path (PGlite migrations + two full reconcile+capture
    // cycles); raise the timeout above vitest's 5s default so it can't flake
    // under CI/parallel-suite CPU contention (it runs in ~0.8s isolated).
  }, 15000);
});
