/**
 * Interprets a Notion webhook delivery's (already-JSON-parsed) body into one
 * of three signals (ADR-06 Finding 1 & 2, issue #39 Build step 2). This is
 * pure classification — it does NOT verify the signature (that is
 * `verifyNotionWebhookSignature`, which needs the RAW body) and it never
 * reads a property VALUE out of the payload: ADR-06 Finding 1 is that
 * webhook payloads carry IDs only (`updated_properties` is a list of
 * property IDs, no values), so every event just means "something changed,
 * fetch-latest." Only entity/parent IDs are extracted here, never
 * `data.updated_properties` or any property content.
 */
export type WebhookSignal =
  | { kind: "verification"; verificationToken: string }
  | { kind: "event"; eventType: string; dataSourceId?: string; pageId?: string; timestamp?: string }
  | { kind: "unrecognized" };

/**
 * The live event-name catalog is one of ADR-06's flagged "Must verify
 * against the LIVE API" items (§ "Must verify" item 2) — 23 event types are
 * documented, one third-party source cited conflicting names. Per the
 * issue's constraint, this implements the DOCUMENTED catalog
 * (`page.properties_updated`, `page.content_updated`, `data_source.*`) and
 * treats anything else as `unrecognized` (safe no-op ack) rather than
 * guessing at undocumented names.
 */
function isKnownEventType(type: string): boolean {
  return (
    type === "page.properties_updated" ||
    type === "page.content_updated" ||
    type.startsWith("data_source.")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Extracts an ID from a Notion `{ id, type }` entity/parent reference —
 * never anything else off it. */
function readEntityId(value: unknown, wantType: "data_source" | "page"): string | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type !== wantType) return undefined;
  return typeof value.id === "string" ? value.id : undefined;
}

export function parseWebhookSignal(body: unknown): WebhookSignal {
  if (!isRecord(body)) return { kind: "unrecognized" };

  // (a) One-time verification handshake (ADR-06 Finding 2): a bare
  // `verification_token`, no event `type`. Must be checked BEFORE the event
  // branch — this request carries no signature to verify against yet.
  if (typeof body.verification_token === "string" && body.type === undefined) {
    return { kind: "verification", verificationToken: body.verification_token };
  }

  // (b) An event delivery.
  const eventType = body.type;
  if (typeof eventType !== "string" || !isKnownEventType(eventType)) {
    return { kind: "unrecognized" };
  }

  const entity = body.entity;
  const dataSourceIdFromEntity = readEntityId(entity, "data_source");
  const pageId = readEntityId(entity, "page");

  // A page event's containing data source, when present (`data.parent`) —
  // still just an ID reference, never a property value.
  const parent = isRecord(body.data) ? body.data.parent : undefined;
  const dataSourceIdFromParent = readEntityId(parent, "data_source");

  const dataSourceId = dataSourceIdFromEntity ?? dataSourceIdFromParent;
  // Notion's documented top-level delivery `timestamp` (ADR-06: "no ordering
  // guarantee — reorder by timestamp"). Used only for replay/staleness
  // bounding (issue #41) — never for ordering/content decisions here.
  const timestamp = typeof body.timestamp === "string" ? body.timestamp : undefined;

  return {
    kind: "event",
    eventType,
    ...(dataSourceId !== undefined ? { dataSourceId } : {}),
    ...(pageId !== undefined ? { pageId } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
  };
}
