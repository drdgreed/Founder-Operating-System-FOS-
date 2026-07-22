import type {
  GenerateStructuredInput,
  GenerateStructuredResult,
  ModelClient,
} from "../model-client.js";
import type { ComplianceReviewer } from "../types.js";

type ScriptedResult = GenerateStructuredResult | (() => GenerateStructuredResult);

/**
 * The #1 safety property's test fixture (issue #50): a hermetic, in-memory
 * `ModelClient` fake. No test in this package ever constructs
 * `AnthropicModelClient` for a `runAgent` call — every hermetic scenario
 * injects this instead, so no real Anthropic call / spend can ever occur.
 */
export class FakeModelClient implements ModelClient {
  readonly calls: GenerateStructuredInput[] = [];
  private readonly queue: ScriptedResult[];

  constructor(scripted: ScriptedResult[]) {
    this.queue = [...scripted];
  }

  async generateStructured(input: GenerateStructuredInput): Promise<GenerateStructuredResult> {
    this.calls.push(input);
    const next = this.queue.shift();
    if (!next) {
      throw new Error(`FakeModelClient: no scripted result left for call #${this.calls.length}`);
    }
    return typeof next === "function" ? next() : next;
  }
}

const DEFAULT_USAGE = { inputTokens: 10, outputTokens: 10 };

export function validResult(output: unknown): GenerateStructuredResult {
  return { output, usage: DEFAULT_USAGE };
}

export function invalidResult(): GenerateStructuredResult {
  // Missing required fields / wrong types — fails the smoke agent's Zod
  // outputSchema regardless of what the definition under test expects.
  return { output: { unexpected: true }, usage: DEFAULT_USAGE };
}

// ---------------------------------------------------------------------------
// Stage-7b compliance-reviewer stubs (Option C slice 2, issue #109).
//
// The pipeline's compliance-review stage takes an INJECTABLE reviewer
// (`deps.complianceReviewer`) so tests decide the compliance verdict WITHOUT
// scripting classifier model calls through the generation `FakeModelClient`.
// `guaranteeKeywordReviewer` mirrors what the real classifier does for the test
// corpus: BLOCK any text mentioning "guarantee" (every guarantee-injection
// fixture in this package contains that word), ALLOW everything else — so ONE
// stub drives both the happy-path (benign → allow) and guarantee-injection
// (guarantee → block) scenarios across every migrated agent.
// ---------------------------------------------------------------------------

/** Blocks any text containing "guarantee" (case-insensitive); allows the rest. */
export const guaranteeKeywordReviewer: ComplianceReviewer = async (text: string) =>
  /guarantee/i.test(text)
    ? { verdict: "block", reason: `test stub: prohibited guarantee detected: "${text}"` }
    : { verdict: "allow", reason: "test stub: benign readiness copy" };

/** Always allows — a benign compliance stub for happy-path-only scenarios. */
export const allowAllReviewer: ComplianceReviewer = async () => ({
  verdict: "allow",
  reason: "test stub: allow",
});

/** Always blocks — for asserting the stage's block path directly. */
export const blockAllReviewer: ComplianceReviewer = async () => ({
  verdict: "block",
  reason: "test stub: block",
});

/** Throws — exercises the stage's fail-closed wrapper (an exception must BLOCK,
 * never bypass the review). */
export const throwingReviewer: ComplianceReviewer = async () => {
  throw new Error("test stub: compliance reviewer boom");
};
