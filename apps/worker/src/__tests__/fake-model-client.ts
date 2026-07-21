import type { GenerateStructuredInput, GenerateStructuredResult, ModelClient } from "@fos/agents";

type ScriptedResult = GenerateStructuredResult | (() => GenerateStructuredResult);

/**
 * Hermetic, in-memory `ModelClient` fake — the worker's copy of the agents
 * package's test fake (that one lives in `packages/agents/src/__tests__` and is
 * not a public export, so it is intentionally duplicated here rather than
 * cross-imported from another package's test tree). No worker test ever
 * constructs a real `AnthropicModelClient`, so no real Anthropic call / spend
 * can occur in CI (the #1 safety property).
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
