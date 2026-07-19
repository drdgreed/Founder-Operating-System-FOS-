import type {
  GenerateStructuredInput,
  GenerateStructuredResult,
  ModelClient,
} from "../model-client.js";

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
