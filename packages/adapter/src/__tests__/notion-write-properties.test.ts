import { describe, it, expect } from "vitest";
import {
  richText,
  selectProp,
  numberProp,
  dateProp,
  NOTION_RICH_TEXT_MAX,
  NOTION_RICH_TEXT_MAX_OBJECTS,
  RICH_TEXT_TRUNCATION_MARKER,
} from "../notion-write-properties.js";

describe("richText", () => {
  it("maps null to an empty rich_text array", () => {
    expect(richText(null)).toEqual({ rich_text: [] });
  });

  it("emits a single text object for content at or under the 2000-char cap", () => {
    const short = "a short summary";
    expect(richText(short)).toEqual({ rich_text: [{ text: { content: short } }] });

    const exactlyMax = "x".repeat(NOTION_RICH_TEXT_MAX);
    const atCap = richText(exactlyMax);
    expect(atCap.rich_text).toHaveLength(1);
    expect(atCap.rich_text[0]).toEqual({ text: { content: exactlyMax } });
  });

  it("splits over-2000-char content losslessly into consecutive <=2000-char objects", () => {
    // 4500 chars -> ceil(4500 / 2000) = 3 objects (2000 + 2000 + 500).
    const content = "y".repeat(4500);
    const result = richText(content);
    expect(result.rich_text).toHaveLength(3);
    const chunks = result.rich_text as { text: { content: string } }[];
    for (const chunk of chunks) {
      expect(chunk.text.content.length).toBeLessThanOrEqual(NOTION_RICH_TEXT_MAX);
    }
    // Lossless: concatenating the chunks reproduces the original exactly.
    expect(chunks.map((c) => c.text.content).join("")).toBe(content);
  });

  it("caps at 100 objects and appends a visible truncation marker beyond that", () => {
    // 101 full 2000-char chunks would exceed the 100-object array cap.
    const content = "z".repeat(NOTION_RICH_TEXT_MAX * (NOTION_RICH_TEXT_MAX_OBJECTS + 1));
    const result = richText(content);
    const chunks = result.rich_text as { text: { content: string } }[];
    expect(chunks).toHaveLength(NOTION_RICH_TEXT_MAX_OBJECTS);
    const last = chunks.at(-1);
    if (!last) throw new Error("expected a capped last chunk");
    // Last chunk stays within the per-object cap and ends with the marker.
    expect(last.text.content.length).toBe(NOTION_RICH_TEXT_MAX);
    expect(last.text.content.endsWith(RICH_TEXT_TRUNCATION_MARKER)).toBe(true);
  });
});

describe("selectProp", () => {
  it("maps null to a cleared select", () => {
    expect(selectProp(null)).toEqual({ select: null });
  });

  it("maps an empty string to a cleared select (Notion rejects empty option names)", () => {
    expect(selectProp("")).toEqual({ select: null });
  });

  it("maps a non-empty value to a named select", () => {
    expect(selectProp("USD")).toEqual({ select: { name: "USD" } });
  });
});

describe("numberProp", () => {
  it("maps null to a cleared number (not wrapped in an object)", () => {
    expect(numberProp(null)).toEqual({ number: null });
  });

  it("maps a value through unchanged", () => {
    expect(numberProp(42)).toEqual({ number: 42 });
  });
});

describe("dateProp", () => {
  it("maps null to a cleared date", () => {
    expect(dateProp(null)).toEqual({ date: null });
  });

  it("maps a Date to an ISO-8601 (UTC) start", () => {
    const d = new Date("2026-07-20T09:30:00Z");
    expect(dateProp(d)).toEqual({ date: { start: "2026-07-20T09:30:00.000Z" } });
  });
});
