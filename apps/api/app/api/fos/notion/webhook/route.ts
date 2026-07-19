import { NextRequest, NextResponse } from "next/server";
import { NotionClient } from "@fos/notion";
import { getDb } from "../../../../../lib/db.js";
import { handleNotionWebhook } from "../../../../../lib/notion-webhook.js";

/**
 * `POST /api/fos/notion/webhook` (issue #39, slice 0.2f) — the Notion
 * webhook OPTIMIZER. SECURITY-CRITICAL: this is a new PUBLIC HTTP endpoint,
 * unlike the other `apps/api` routes it is NOT gated by `requireServiceAuth`
 * (Notion cannot present our bearer token) — its only defense is the
 * `X-Notion-Signature` HMAC check inside `handleNotionWebhook`.
 *
 * The body is read as RAW text (`req.text()`), never `req.json()` — HMAC
 * verification needs the exact bytes Notion sent; JSON-reparsing then
 * re-stringifying is not guaranteed to round-trip byte-for-byte and would
 * make a genuine signature fail to verify.
 *
 * `workspaceId`/`dataSourceId` come from server config (env), never the
 * request — same "server-bound principal, never the client body" posture as
 * `lib/auth.ts`. Env is read at call time so tests can vary it per case.
 */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signatureHeader = req.headers.get("x-notion-signature");

  const notionClient = new NotionClient({ fetchImpl: fetch });

  const result = await handleNotionWebhook(
    { db: getDb(), notionClient },
    {
      // ADR-05 single-workspace shim: the same workspace `requireServiceAuth`
      // binds client requests to.
      workspaceId: process.env.FOS_SERVICE_WORKSPACE_ID ?? "",
      dataSourceId: process.env.FOS_NOTION_ENROLLMENT_DATA_SOURCE_ID ?? "",
      workspaceIntegrationId: process.env.FOS_NOTION_WORKSPACE_INTEGRATION_ID ?? null,
    },
    rawBody,
    signatureHeader,
  );
  if (result.logError) {
    // The fetch-latest optimizer failed but the request is ack'd 200 (the
    // poll loop backstops correctness — see handleNotionWebhook). Record it
    // server-side so the failing optimizer isn't invisible to operators.
    // Log only the message, never the request body or any secret.
    console.error(
      "[notion-webhook] fetch-latest trigger failed:",
      result.logError instanceof Error ? result.logError.message : String(result.logError),
    );
  }
  return NextResponse.json(result.body, { status: result.status });
}
