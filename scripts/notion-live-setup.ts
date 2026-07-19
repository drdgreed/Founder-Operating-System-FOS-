/**
 * ONE-SHOT live setup + validation for the Notion adapter, run AFTER the
 * "Enrollment Pipeline" database exists and the FOS integration is connected
 * to it (both done via the browser). It:
 *   1. resolves the DATA SOURCE id from the database id (it's not in the URL),
 *   2. adds the 8 §C1/§13.2 properties the adapter needs (idempotent — safe to
 *      re-run), so the schema matches what 0.2b projects,
 *   3. creates one labelled test page using the adapter's exact createPage
 *      shape, proving token + client + schema all work against live Notion,
 *   4. prints the DATA SOURCE id for you to export.
 *
 * The token is read from process.env.FOS_NOTION_TOKEN — this script (and Claude)
 * never sees its value. Run from the repo root:
 *
 *   FOS_NOTION_TOKEN=... npx tsx scripts/notion-live-setup.ts
 *
 * (Optional: FOS_NOTION_ENROLLMENT_DATABASE_ID overrides the database id below.)
 */
const TOKEN = process.env.FOS_NOTION_TOKEN;
if (!TOKEN) {
  console.error("✗ FOS_NOTION_TOKEN is not set in the environment.");
  process.exit(1);
}
// The "Enrollment Pipeline" database Claude created in David Reed's Space.
const DATABASE_ID =
  process.env.FOS_NOTION_ENROLLMENT_DATABASE_ID ?? "3a2d6ee5461a808db9bad833b1e2a19e";

const BASE = "https://api.notion.com/v1";
const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  "Notion-Version": "2026-03-11",
  "Content-Type": "application/json",
};

async function api(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: HEADERS,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

// The §C1 hidden-property contract + Stage, matching 0.2b's mapper exactly.
const PROPERTY_SCHEMA: Record<string, unknown> = {
  "FOS Record ID": { rich_text: {} },
  "FOS Entity Type": { rich_text: {} },
  "FOS Workspace ID": { rich_text: {} },
  "FOS Product ID": { rich_text: {} },
  "Sync Status": {
    select: {
      options: [
        "pending",
        "in_sync",
        "fos_ahead",
        "provider_ahead",
        "conflict",
        "failed",
        "disabled",
      ].map((name) => ({ name })),
    },
  },
  "FOS Version": { number: {} },
  "Last Synced At": { date: {} },
  Stage: {
    select: {
      options: [
        "new_lead",
        "reviewing",
        "contacted",
        "conversation_scheduled",
        "conversation_completed",
        "offered",
        "enrolled",
        "declined",
        "deferred",
        "unresponsive",
        "disqualified",
      ].map((name) => ({ name })),
    },
  },
};

async function main(): Promise<void> {
  // 1) Resolve the data source id from the database.
  console.log(`1) Resolving data source for database ${DATABASE_ID}…`);
  const db = await api("GET", `/databases/${DATABASE_ID}`);
  const dataSources = db.data_sources as Array<{ id: string; name?: string }> | undefined;
  if (!dataSources || dataSources.length === 0) {
    throw new Error(
      `No data_sources on this database. Response keys: ${Object.keys(db).join(", ")}`,
    );
  }
  const dataSourceId = dataSources[0]!.id;
  console.log(`   ✓ data source id: ${dataSourceId}\n`);

  // 2) Add the 8 properties (idempotent — Notion merges the schema).
  console.log("2) Adding the §C1 property schema to the data source…");
  await api("PATCH", `/data_sources/${dataSourceId}`, { properties: PROPERTY_SCHEMA });
  console.log("   ✓ properties ensured\n");

  // 3) Create a test page using the adapter's exact createPage shape.
  console.log("3) Creating a test page (adapter's exact shape — proves the schema matches)…");
  const now = new Date().toISOString();
  const testId = `live-test-${Date.now()}`;
  const page = (await api("POST", "/pages", {
    parent: { data_source_id: dataSourceId },
    properties: {
      Name: { title: [{ text: { content: `FOS live validation ${testId}` } }] },
      "FOS Record ID": { rich_text: [{ text: { content: testId } }] },
      "FOS Entity Type": { rich_text: [{ text: { content: "EnrollmentOpportunity" } }] },
      "FOS Workspace ID": { rich_text: [{ text: { content: "live-validate" } }] },
      "FOS Product ID": { rich_text: [] },
      "Sync Status": { select: { name: "in_sync" } },
      "FOS Version": { number: 1 },
      "Last Synced At": { date: { start: now } },
      Stage: { select: { name: "new_lead" } },
    },
  })) as { id?: string; url?: string };
  console.log(`   ✓ created page ${page.id ?? "(no id)"}`);
  console.log(`   → open it in Notion: ${page.url ?? "(no url returned)"}\n`);

  console.log("✅ LIVE WIRING CONFIRMED — token, client, and the §C1 schema all work.\n");
  console.log("Now export the data source id so the adapter/scripts can use it:\n");
  console.log(`   export FOS_NOTION_ENROLLMENT_DATA_SOURCE_ID='${dataSourceId}'\n`);
}

main().catch((err: unknown) => {
  console.error("\n✗ SETUP FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
