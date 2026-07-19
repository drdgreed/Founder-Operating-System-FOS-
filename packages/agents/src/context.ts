import type { RunAgentContext } from "./types.js";

/**
 * Stage 3 output (ADR-07 D2): the retrieved-context manifest. Recorded
 * verbatim into `agent_run.context_manifest_json` so a run's context can be
 * reconstructed from the audit spine alone. Minimization (least privilege):
 * the manifest lists only the definition's declared `permittedMemoryScopes`
 * — never a dump of everything the runtime COULD read.
 */
export interface AssembledContext<TInput> {
  manifest: Record<string, unknown>;
  input: TInput;
}

export function assembleContext<TInput>(
  definition: { key: string; version: string; permittedMemoryScopes: readonly string[] },
  input: TInput,
  runContext: RunAgentContext,
): AssembledContext<TInput> {
  return {
    manifest: {
      agentKey: definition.key,
      agentVersion: definition.version,
      permittedMemoryScopes: definition.permittedMemoryScopes,
      workspaceId: runContext.workspaceId,
      productId: runContext.productId ?? null,
      trigger: runContext.trigger,
    },
    input,
  };
}
