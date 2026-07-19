import type { Db } from "@fos/db/services";
import { NotionClient } from "@fos/notion";
import {
  verifyNotionWebhookSignature,
  resolveWebhookVerificationToken,
  parseWebhookSignal,
} from "@fos/notion";
import { reconcile, captureStageCommands } from "@fos/adapter";
import type { HandlerResult } from "./handlers.js";

/**
 * Testable core for `POST /api/fos/notion/webhook` (issue #39, slice 0.2f —
 * the webhook OPTIMIZER). Per ADR-06, webhooks are a latency optimizer ONLY
 * on top of the poll-authoritative loop: this handler NEVER reads a payload
 * property value into canonical state — a valid, known event only ever
 * triggers a fetch-latest via the already-authoritative, idempotent 0.2c
 * `reconcile` + 0.2d `captureStageCommands` poll. The system stays provably
 * correct with this endpoint disabled entirely.
 *
 * `reconcileFn`/`captureStageCommandsFn` are injectable so tests can stub
 * the fetch-latest trigger without exercising the real Notion HTTP/poll path
 * (per the issue's test guidance: "mock; inject the reconcile/capture
 * triggers or a stub").
 */
export interface NotionWebhookDeps {
  db: Db;
  notionClient: NotionClient;
  reconcileFn?: typeof reconcile;
  captureStageCommandsFn?: typeof captureStageCommands;
}

export interface NotionWebhookConfig {
  /** The single founder workspace this webhook feeds (ADR-05: single-workspace
   * shim; same value as `FOS_SERVICE_WORKSPACE_ID`). Empty/unset fails closed. */
  workspaceId: string;
  /** The Notion data source (Enrollment Pipeline) to fetch-latest on any
   * valid event. FLAG: there is no per-workspace data-source registry yet
   * (no schema/config maps an arbitrary payload `dataSourceId`/`pageId` to a
   * FOS workspace) — this slice is scoped to the single configured
   * Enrollment Pipeline data source, matching every other 0.2 sub-slice's
   * single-data-source scope. Re-fetching this data source is always safe
   * (idempotent, IDs-only) even for an event about a different page/data
   * source, so this is a correct if imprecise "map to the affected data
   * source" for the current single-workspace scope; multi-data-source
   * routing is a follow-up once a registry exists. */
  dataSourceId: string;
  /** Nullable per 0.2d's own note: acceptable when integration wiring isn't
   * present yet. */
  workspaceIntegrationId: string | null;
  /** Credential reference (env var name) for the verification_token. Defaults
   * to FOS_NOTION_WEBHOOK_SECRET (see .env.example). */
  webhookCredentialReference?: string;
}

function serviceUnavailable(): HandlerResult {
  return { status: 503, body: { error: "service unavailable" } };
}

function unauthorized(): HandlerResult {
  return { status: 401, body: { error: "unauthorized" } };
}

/**
 * `rawBody` MUST be the exact bytes Notion sent (required for HMAC — do not
 * JSON-reparse-then-stringify, which is not guaranteed to round-trip
 * byte-for-byte). The route reads it via `req.text()` before any JSON
 * parsing happens here.
 */
export async function handleNotionWebhook(
  deps: NotionWebhookDeps,
  config: NotionWebhookConfig,
  rawBody: string,
  signatureHeader: string | null,
): Promise<HandlerResult & { logError?: unknown }> {
  const reconcileFn = deps.reconcileFn ?? reconcile;
  const captureFn = deps.captureStageCommandsFn ?? captureStageCommands;

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    parsedBody = undefined;
  }

  const signal =
    parsedBody === undefined ? { kind: "unrecognized" as const } : parseWebhookSignal(parsedBody);

  if (signal.kind === "verification") {
    // ADR-06 Finding 2: the one-time verification handshake carries NO
    // signature — there is nothing to verify it against until this token is
    // captured. Ack 200 and surface the token ONLY in the response body, for
    // an operator running the handshake manually to capture into the
    // credential reference — it is NEVER logged (see verify-webhook-signature.ts).
    return {
      status: 200,
      body: {
        status: "verification_received",
        message:
          "capture verification_token into the webhook credential reference (FOS_NOTION_WEBHOOK_SECRET by default); it is not persisted automatically",
        verification_token: signal.verificationToken,
      },
    };
  }

  // Every other path (a real event, or an unrecognized/malformed body) MUST
  // verify the signature before anything else — reject unsigned/invalid
  // with 401, without leaking which check failed.
  let verificationToken: string;
  try {
    verificationToken = resolveWebhookVerificationToken(config.webhookCredentialReference);
  } catch {
    // Fail closed (mirrors requireServiceAuth's ServiceUnconfiguredError):
    // the service never verifies webhooks while the token is unconfigured.
    return serviceUnavailable();
  }

  const signatureValid = verifyNotionWebhookSignature(rawBody, signatureHeader, verificationToken);
  if (!signatureValid) {
    return unauthorized();
  }

  if (signal.kind === "event") {
    // Fail closed: without a configured workspace/data source, do not guess
    // — never trigger a fetch-latest against an unconfigured target.
    if (!config.workspaceId || !config.dataSourceId) {
      return serviceUnavailable();
    }

    // The payload is UNTRUSTED and IDs-only (ADR-06 Finding 1): this ONLY
    // triggers the already-authoritative, idempotent poll — it never writes
    // any payload value to canonical state. At-most-once/unordered/retried/
    // batched deliveries are fine because a re-poll just re-derives current
    // state; `reconcile`/`captureStageCommands` already dedup on their own
    // keys, so no new webhook-delivery dedup table is needed here.
    try {
      await reconcileFn(deps.db, deps.notionClient, {
        workspaceId: config.workspaceId,
        dataSourceId: config.dataSourceId,
      });
      await captureFn(deps.db, deps.notionClient, {
        workspaceId: config.workspaceId,
        dataSourceId: config.dataSourceId,
        workspaceIntegrationId: config.workspaceIntegrationId,
      });
    } catch (err) {
      // The webhook is a pure OPTIMIZER; a failed fetch-latest loses only
      // latency, never data — the authoritative poll loop (0.2c/0.2d)
      // re-derives this change on its next cycle. Ack 200 (deliberately NOT
      // 5xx: a persistent trigger failure must not make Notion hammer this
      // endpoint under its 8x/24h retry policy, amplifying an outage), and
      // surface the error via `logError` for the route to record so the
      // failing optimizer is not silent to operators.
      return { status: 200, body: { status: "ok" }, logError: err };
    }
  }

  // A signed-but-unrecognized event type is ack'd without action (safe
  // no-op) rather than 401 — it authenticated fine, FOS just has nothing to
  // do with it (e.g. an event outside the documented catalog this slice
  // implements; see parse-webhook-signal.ts).
  return { status: 200, body: { status: "ok" } };
}
