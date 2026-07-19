import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  verifyNotionWebhookSignature,
  resolveWebhookVerificationToken,
  WebhookTokenUnconfiguredError,
} from "../verify-webhook-signature.js";

const TOKEN = "test-verification-token";

function sign(rawBody: string, token = TOKEN): string {
  return `sha256=${createHmac("sha256", token).update(rawBody).digest("hex")}`;
}

describe("verifyNotionWebhookSignature (issue #39, slice 0.2f — ADR-06 Finding 2)", () => {
  it("FOS0-WHK-01: a valid HMAC-SHA256 signature over the raw body verifies true", () => {
    const rawBody = JSON.stringify({ type: "page.properties_updated", entity: { id: "p1" } });
    expect(verifyNotionWebhookSignature(rawBody, sign(rawBody), TOKEN)).toBe(true);
  });

  it("accepts a bare hex digest without the sha256= prefix", () => {
    const rawBody = JSON.stringify({ type: "page.properties_updated" });
    const digest = createHmac("sha256", TOKEN).update(rawBody).digest("hex");
    expect(verifyNotionWebhookSignature(rawBody, digest, TOKEN)).toBe(true);
  });

  it("FOS0-WHK-02: a wrong-token signature (invalid signature) verifies false", () => {
    const rawBody = JSON.stringify({ type: "page.properties_updated" });
    expect(verifyNotionWebhookSignature(rawBody, sign(rawBody, "wrong-token"), TOKEN)).toBe(false);
  });

  it("a tampered body (signature computed over a different body) verifies false", () => {
    const original = JSON.stringify({ type: "page.properties_updated", entity: { id: "p1" } });
    const tampered = JSON.stringify({ type: "page.properties_updated", entity: { id: "p2" } });
    expect(verifyNotionWebhookSignature(tampered, sign(original), TOKEN)).toBe(false);
  });

  it("FOS0-WHK-03: a missing signature header verifies false", () => {
    const rawBody = JSON.stringify({ type: "page.properties_updated" });
    expect(verifyNotionWebhookSignature(rawBody, null, TOKEN)).toBe(false);
    expect(verifyNotionWebhookSignature(rawBody, undefined, TOKEN)).toBe(false);
    expect(verifyNotionWebhookSignature(rawBody, "", TOKEN)).toBe(false);
  });

  it("a malformed (non-hex, wrong-length) signature never throws and verifies false", () => {
    const rawBody = JSON.stringify({ type: "page.properties_updated" });
    expect(() =>
      verifyNotionWebhookSignature(rawBody, "sha256=not-hex-at-all!!", TOKEN),
    ).not.toThrow();
    expect(verifyNotionWebhookSignature(rawBody, "sha256=not-hex-at-all!!", TOKEN)).toBe(false);
    expect(verifyNotionWebhookSignature(rawBody, "sha256=ab", TOKEN)).toBe(false);
  });

  it("SECURITY: the constant-time compare rejects same-length-but-wrong digests without throwing", () => {
    const rawBody = JSON.stringify({ type: "page.properties_updated" });
    // A same-length (64 hex chars = 32 bytes), well-formed, but incorrect digest.
    const wrongSameLength = "0".repeat(64);
    expect(() => verifyNotionWebhookSignature(rawBody, wrongSameLength, TOKEN)).not.toThrow();
    expect(verifyNotionWebhookSignature(rawBody, wrongSameLength, TOKEN)).toBe(false);
  });
});

describe("resolveWebhookVerificationToken (credential-reference pattern)", () => {
  const REF = "FOS_TEST_WEBHOOK_TOKEN";
  const original = process.env[REF];

  it("reads the token from the named credential reference at call time", () => {
    process.env[REF] = "resolved-secret";
    try {
      expect(resolveWebhookVerificationToken(REF)).toBe("resolved-secret");
    } finally {
      if (original === undefined) delete process.env[REF];
      else process.env[REF] = original;
    }
  });

  it("throws WebhookTokenUnconfiguredError (never including the token) when unset", () => {
    delete process.env[REF];
    try {
      expect(() => resolveWebhookVerificationToken(REF)).toThrow(WebhookTokenUnconfiguredError);
      try {
        resolveWebhookVerificationToken(REF);
      } catch (err) {
        expect(String(err)).not.toMatch(/resolved-secret/);
        expect(String(err)).toMatch(REF);
      }
    } finally {
      if (original === undefined) delete process.env[REF];
      else process.env[REF] = original;
    }
  });

  it("defaults to FOS_NOTION_WEBHOOK_SECRET when no reference is given", () => {
    const saved = process.env.FOS_NOTION_WEBHOOK_SECRET;
    process.env.FOS_NOTION_WEBHOOK_SECRET = "default-secret";
    try {
      expect(resolveWebhookVerificationToken()).toBe("default-secret");
    } finally {
      if (saved === undefined) delete process.env.FOS_NOTION_WEBHOOK_SECRET;
      else process.env.FOS_NOTION_WEBHOOK_SECRET = saved;
    }
  });
});
