# ADR-06 — Notion Integration Boundary (capability spike → adapter decision)

**Status:** ACCEPTED (findings) · gates slice 0.2 (the Notion adapter) · **Date:** 2026-07-17
**Context:** FOS is the canonical system of record; Notion is a provider-neutral **workspace adapter** (projections FOS→Notion + commands Notion→FOS). Auth decided in ADR-05 (internal-integration token, single founder workspace). This ADR records a capability spike against the current Notion API (version **2026-03-01**) so the adapter is built on verified mechanics, not assumptions.

## Findings (all cited to developers.notion.com / notion.com/help)
1. **Webhooks — signal only, not content.** 23 event types (`page.properties_updated`, `page.content_updated`, `data_source.*`; note `database.*` is deprecated → `data_source.*`). **Payloads carry IDs only** (`updated_properties` = property IDs, no values) → every event forces a **fetch-latest** call. Delivery is **at-most-once**, **no ordering guarantee** (reorder by `timestamp`), retried up to 8× (~24h), high-frequency edits **batched**.
2. **Signature verification (confirmed).** One-time `verification_token` handshake on subscription creation; per-event `X-Notion-Signature` = **HMAC-SHA256(raw body, verification_token)**, constant-time compare. SDK: `verifyWebhookSignature()`.
3. **"Approve" command path (confirmed).** Notion **"Send webhook" action** on buttons/database-automations → POST to any external URL, **custom headers supported**, **POST only**, **paid plan**, max 5/automation. **Notion does NOT sign these** → auth is our shared-secret header over TLS.
4. **Polling primitive (confirmed).** Query a data source with `filter: {timestamp: last_edited_time, last_edited_time: {after: <ISO>}}` (works even without a Last-edited property). The reliable, documented change-detection signal.
5. **Rate limits.** ~**3 req/s per connection** (some burst), plus a per-workspace shared limit (unpublished number); 429/529 + honor **`Retry-After`**; size caps (1000 blocks / 500 KB / 2000-char rich text / 100 relations per request).
6. **Internal token.** Correct for single-workspace; same content capabilities as public. Access is **page-scoped** — projected DBs must be explicitly shared to the integration.

## Decision (slice 0.2)
- **Capture = poll-authoritative, webhook-optimized.** Build the **`last_edited_time` reconciliation loop first** as the source of truth — the system must be provably correct with webhooks *disabled*. Add webhooks (`page.properties_updated` + `data_source.*`) as a latency optimizer that only ever means "something changed, refetch," gated on Risk #1 below.
- **One shared, rate-limited Notion client** — token bucket ~3 rps, honor `Retry-After` on 429/529, bounded concurrency. All projection writes + fetch-latest reads go through it.
- **Two inbound endpoints:** `/notion/webhook` (verify `X-Notion-Signature` HMAC) and `/notion/command` (the Approve-button receiver, authed by a **shared-secret custom header** — Notion won't sign it).
- **Poll every ~2 min with a ~30s cursor-overlap** window (inside Notion's ~1 min typical / 5 min max delivery + batching).
- **Idempotency:** change events deduped on `(page_id, last_edited_time)`; captured commands on `(page_id + property-hash + button nonce)`. A `WorkspaceCommand` is emitted only after a successful fetch-latest + diff, so replays / out-of-order deliveries collapse to one canonical FOS mutation.

## Must verify against the LIVE API before adapter code
1. **Internal-integration webhook eligibility (highest priority, ~10 min):** create a subscription on the real FOS internal integration. The official webhooks ref doesn't explicitly confirm internal integrations can subscribe; if they can't, the fast-path collapses to **poll-only** (design already survives this).
2. **Webhook management surface + event names** — webhooks are beta; one third-party source cited a `/v1/webhooks` REST endpoint + `page.updated`/`database.row_added` that contradict the official `page.properties_updated` catalog. Confirm at build time.
3. **`last_edited_time` bump reliability** for every founder-visible property type (rollup/relation/formula edges).
4. **Per-workspace rate-limit number** — measure under realistic projection+reconcile load.

## Security note (needs human confirmation before real "Approve" decisions)
The **outbound Approve button is unsigned by Notion** — the `/notion/command` endpoint's only defense is the shared-secret header + replay protection. A human must confirm: the secret is rotated, the endpoint **rejects unsigned/replayed commands**, and it runs over TLS, before it handles a real approval.

## Provenance
Capability spike, 2026-07-17. Sources: Notion webhooks-events-delivery, webhooks (signature), request-limits, webhook-actions (Help), database-automations (Help), filter-by-timestamp changelog, create-integrations (Help). Confidence + unverified items are flagged inline; items under "Must verify" are explicitly not confirmed against a live FOS integration yet.
