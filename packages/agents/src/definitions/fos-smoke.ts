import { z } from "zod";
import { featureModeAllowedGate } from "../gates/feature-mode-allowed.js";
import { noProhibitedValueGate } from "../gates/no-prohibited-value.js";
import type { AgentDefinition } from "../types.js";

/**
 * `fos.smoke` — the harness-proving stub agent (issue #50). NO real business
 * logic: it exists only to exercise all 12 pipeline stages end to end. The
 * first real business agent (Enrollment Brief) is P1.2.
 */
export const smokeAgentInputSchema = z.object({
  /** Trivially "untrusted" free text (e.g. a note pasted from a webhook). The
   * D9 prompt-injection test feeds attack strings through this field. */
  note: z.string(),
});

export const smokeAgentOutputSchema = z.object({
  message: z.string(),
  itemCount: z.number().int().nonnegative(),
});

export type SmokeAgentInput = z.infer<typeof smokeAgentInputSchema>;
export type SmokeAgentOutput = z.infer<typeof smokeAgentOutputSchema>;

// FLAG: `artifact_domain` (packages/db/src/schema/artifact_record.ts) has no
// generic/system value — every member is a real Phase-0/1 business domain.
// A harness smoke-test artifact does not belong to any of them; "research" is
// used here as the closest-fit placeholder (an internal diagnostic note),
// not a claim that fos.smoke is a research artifact. Adding a new enum member
// for a non-shipping stub agent was judged out of scope for this slice.
export const FOS_SMOKE_AGENT_KEY = "fos.smoke";
export const FOS_SMOKE_FEATURE_FLAG_KEY = "fos.smoke";

export const fosSmokeAgentDefinition: AgentDefinition<SmokeAgentInput, SmokeAgentOutput> = {
  key: FOS_SMOKE_AGENT_KEY,
  version: "1.0.0",
  objective:
    "Harness smoke test: read a short note, summarize it in one sentence, and count how many words it contains. No business logic.",
  inputSchema: smokeAgentInputSchema,
  outputSchema: smokeAgentOutputSchema,
  permittedTools: [],
  permittedMemoryScopes: ["none"],
  autonomyCeiling: "review",
  featureFlagKey: FOS_SMOKE_FEATURE_FLAG_KEY,
  deterministicGates: [
    featureModeAllowedGate({ key: "fos.smoke.mode-allowed", allowedModes: ["shadow", "review"] }),
    noProhibitedValueGate({
      key: "fos.smoke.no-prohibited-value",
      select: (output: SmokeAgentOutput) => output.message,
      prohibited: ["DO_NOT_SHIP"],
    }),
  ],
  artifact: {
    artifactType: "internal_note",
    domain: "research",
    buildTitle: (input: SmokeAgentInput) => `Smoke run: ${input.note.slice(0, 60)}`,
    buildBodyMarkdown: (_input: SmokeAgentInput, output: SmokeAgentOutput) =>
      `${output.message}\n\nWord count: ${output.itemCount}`,
  },
};
