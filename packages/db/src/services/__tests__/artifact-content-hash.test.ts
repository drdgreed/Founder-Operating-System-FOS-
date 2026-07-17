import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { computeContentHash, normalizeMarkdown } from "../content-hash.js";

describe("content_hash normalization (PATCH-SET-01 §S3)", () => {
  it("FOS0-ART-30: markdown differing only by trailing whitespace hashes identically", () => {
    const a = "# Title\n\nBody line";
    const b = "# Title   \n\nBody line   \t";
    expect(computeContentHash(a)).toBe(computeContentHash(b));
  });

  it("FOS0-ART-31: markdown differing only by line endings (CRLF/CR vs LF) hashes identically", () => {
    const lf = "line one\nline two\n";
    const crlf = "line one\r\nline two\r\n";
    const cr = "line one\rline two\r";
    expect(computeContentHash(crlf)).toBe(computeContentHash(lf));
    expect(computeContentHash(cr)).toBe(computeContentHash(lf));
  });

  it("FOS0-ART-32: markdown differing only by trailing newlines hashes identically", () => {
    const one = "same body\n";
    const many = "same body\n\n\n\n";
    const none = "same body";
    expect(computeContentHash(many)).toBe(computeContentHash(one));
    expect(computeContentHash(none)).toBe(computeContentHash(one));
  });

  it("FOS0-ART-33: materially different markdown hashes differently", () => {
    expect(computeContentHash("hello world\n")).not.toBe(computeContentHash("goodbye world\n"));
  });

  it("FOS0-ART-34: content_hash is exactly SHA-256(normalized_markdown) in hex (deterministic)", () => {
    const md = "# Heading  \r\nSome text\n\n\n";
    const normalized = normalizeMarkdown(md);
    expect(normalized).toBe("# Heading\nSome text\n");
    const expected = createHash("sha256").update(normalized).digest("hex");
    expect(computeContentHash(md)).toBe(expected);
    // stable across calls
    expect(computeContentHash(md)).toBe(computeContentHash(md));
  });
});
