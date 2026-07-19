import { describe, it, expect } from "vitest";
import { parseWebhookSignal } from "../parse-webhook-signal.js";

describe("parseWebhookSignal (issue #39, slice 0.2f — ADR-06 Finding 1 & 2)", () => {
  it("FOS0-WHK-04: a verification handshake body -> { kind: 'verification' }", () => {
    const signal = parseWebhookSignal({ verification_token: "abc123" });
    expect(signal).toEqual({ kind: "verification", verificationToken: "abc123" });
  });

  it("a page.properties_updated event with a page entity -> { kind: 'event', pageId }", () => {
    const signal = parseWebhookSignal({
      type: "page.properties_updated",
      entity: { id: "page-1", type: "page" },
      data: { parent: { id: "ds-1", type: "data_source" }, updated_properties: ["prop-a"] },
    });
    expect(signal).toEqual({
      kind: "event",
      eventType: "page.properties_updated",
      pageId: "page-1",
      dataSourceId: "ds-1",
    });
  });

  it("a page.content_updated event is recognized", () => {
    const signal = parseWebhookSignal({
      type: "page.content_updated",
      entity: { id: "page-2", type: "page" },
    });
    expect(signal).toEqual({ kind: "event", eventType: "page.content_updated", pageId: "page-2" });
  });

  it("a data_source.* event with a data_source entity -> { kind: 'event', dataSourceId }", () => {
    const signal = parseWebhookSignal({
      type: "data_source.content_updated",
      entity: { id: "ds-9", type: "data_source" },
    });
    expect(signal).toEqual({
      kind: "event",
      eventType: "data_source.content_updated",
      dataSourceId: "ds-9",
    });
  });

  it("FOS0-WHK-05 (IDs-only): never reads updated_properties VALUES, only IDs", () => {
    const signal = parseWebhookSignal({
      type: "page.properties_updated",
      entity: { id: "page-3", type: "page" },
      data: {
        // Bogus/attacker-controlled "values" that must never surface anywhere
        // in the parsed signal — ADR-06 Finding 1: payloads are IDs only.
        updated_properties: [{ id: "prop-x", value: "MALICIOUS_STAGE_VALUE" }],
        parent: { id: "ds-3", type: "data_source" },
      },
    });
    expect(signal).toEqual({
      kind: "event",
      eventType: "page.properties_updated",
      pageId: "page-3",
      dataSourceId: "ds-3",
    });
    expect(JSON.stringify(signal)).not.toMatch(/MALICIOUS_STAGE_VALUE/);
  });

  it("an unrecognized event type -> { kind: 'unrecognized' }, not an error", () => {
    expect(parseWebhookSignal({ type: "some.undocumented.event", entity: { id: "x" } })).toEqual({
      kind: "unrecognized",
    });
  });

  it("malformed / non-object bodies -> { kind: 'unrecognized' }, never throws", () => {
    expect(parseWebhookSignal(null)).toEqual({ kind: "unrecognized" });
    expect(parseWebhookSignal(undefined)).toEqual({ kind: "unrecognized" });
    expect(parseWebhookSignal("a string")).toEqual({ kind: "unrecognized" });
    expect(parseWebhookSignal(42)).toEqual({ kind: "unrecognized" });
    expect(parseWebhookSignal([])).toEqual({ kind: "unrecognized" });
    expect(parseWebhookSignal({})).toEqual({ kind: "unrecognized" });
  });

  it("a body with both verification_token AND a type is treated as an event, not a handshake", () => {
    const signal = parseWebhookSignal({
      verification_token: "should-not-win",
      type: "page.properties_updated",
      entity: { id: "page-4", type: "page" },
    });
    expect(signal).toEqual({
      kind: "event",
      eventType: "page.properties_updated",
      pageId: "page-4",
    });
  });

  it("FOS0-WHK-27 (issue #41): an event's top-level `timestamp` is extracted for replay/staleness bounding", () => {
    const signal = parseWebhookSignal({
      type: "page.properties_updated",
      entity: { id: "page-5", type: "page" },
      timestamp: "2026-07-19T12:00:00.000Z",
    });
    expect(signal).toEqual({
      kind: "event",
      eventType: "page.properties_updated",
      pageId: "page-5",
      timestamp: "2026-07-19T12:00:00.000Z",
    });
  });

  it("an event with no timestamp field simply omits it (no staleness gate can apply)", () => {
    const signal = parseWebhookSignal({
      type: "page.properties_updated",
      entity: { id: "page-6", type: "page" },
    });
    expect(signal).toEqual({
      kind: "event",
      eventType: "page.properties_updated",
      pageId: "page-6",
    });
    expect("timestamp" in signal).toBe(false);
  });

  it("a non-string timestamp is ignored rather than surfaced as-is", () => {
    const signal = parseWebhookSignal({
      type: "page.properties_updated",
      entity: { id: "page-7", type: "page" },
      timestamp: 1753963200000,
    });
    expect("timestamp" in signal).toBe(false);
  });
});
