import Anthropic from "@anthropic-ai/sdk";

/** Default Sonnet model tier (ADR-07 §1, D1). */
export const DEFAULT_MODEL = "claude-sonnet-5";

export interface GenerateStructuredInput {
  systemPrompt: string;
  userContent: string;
  /** JSON Schema the structured output must satisfy. */
  outputJsonSchema: Record<string, unknown>;
  model: string;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface GenerateStructuredResult {
  /** Parsed structured output — the runtime Zod-validates this at stage 6. */
  output: unknown;
  usage: ModelUsage;
}

/**
 * The #1 safety property (ADR-07, issue #50): injectable + REQUIRED, no
 * fallback to a real Anthropic call. `runAgent` takes a `ModelClient` as a
 * dependency; tests inject a fake and no real model call / spend can ever
 * happen in CI. Mirrors `NotionClient` (packages/notion/src/client.ts).
 */
export interface ModelClient {
  generateStructured(input: GenerateStructuredInput): Promise<GenerateStructuredResult>;
}

export type AnthropicFetchLike = typeof fetch;

export interface AnthropicModelClientOptions {
  /** Injected fetch — tests supply a mock; no real network in hermetic tests.
   * Mirrors NotionClientOptions.fetchImpl. */
  fetchImpl: AnthropicFetchLike;
  /** process.env var name holding the API key (credential reference, not the
   * secret itself — mirrors NotionClient.credentialReference / getToken).
   * Defaults to ANTHROPIC_API_KEY. */
  credentialReference?: string;
  baseUrl?: string;
}

/**
 * FLAG (genuinely underspecified in ADR-07/issue #50 — "the Anthropic
 * structured-output mechanism"): the Anthropic SDK offers no first-class
 * "JSON mode". The minimal defensible option implemented here is a
 * forced tool-use call — a single tool named `emit_structured_output` whose
 * `input_schema` is the definition's output JSON Schema, with
 * `tool_choice: {type: "tool", name: "emit_structured_output"}` so the model
 * MUST reply with a tool_use block conforming to the schema. This is
 * Anthropic's documented pattern for structured extraction. If a different
 * mechanism (e.g. a future native structured-output API) is preferred,
 * only this class needs to change — `ModelClient` is the stable seam.
 */
const STRUCTURED_OUTPUT_TOOL_NAME = "emit_structured_output";

export class AnthropicModelClient implements ModelClient {
  private readonly fetchImpl: AnthropicFetchLike;
  private readonly credentialReference: string;
  private readonly baseUrl: string | undefined;

  constructor(options: AnthropicModelClientOptions) {
    this.fetchImpl = options.fetchImpl;
    this.credentialReference = options.credentialReference ?? "ANTHROPIC_API_KEY";
    this.baseUrl = options.baseUrl;
  }

  /**
   * Reads the API key from process.env at CALL TIME via the credential
   * reference — never stored on a field, never logged, never included in a
   * thrown error (mirrors NotionClient.getToken exactly).
   */
  private getApiKey(): string {
    const apiKey = process.env[this.credentialReference];
    if (!apiKey) {
      throw new Error(`Anthropic credential reference "${this.credentialReference}" is not set`);
    }
    return apiKey;
  }

  async generateStructured(input: GenerateStructuredInput): Promise<GenerateStructuredResult> {
    const client = new Anthropic({
      apiKey: this.getApiKey(),
      fetch: this.fetchImpl,
      baseURL: this.baseUrl,
    });

    const response = await client.messages.create({
      model: input.model,
      max_tokens: 4096,
      system: input.systemPrompt,
      messages: [{ role: "user", content: input.userContent }],
      tools: [
        {
          name: STRUCTURED_OUTPUT_TOOL_NAME,
          description: "Emit the run's structured result. Always call this exactly once.",
          input_schema: input.outputJsonSchema as Anthropic.Tool["input_schema"],
        },
      ],
      tool_choice: { type: "tool", name: STRUCTURED_OUTPUT_TOOL_NAME },
    });

    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );
    if (!toolUse) {
      throw new Error("AnthropicModelClient: model response contained no tool_use block");
    }

    return {
      output: toolUse.input,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}
