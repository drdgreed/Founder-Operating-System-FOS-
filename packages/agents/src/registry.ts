import type { AgentDefinition } from "./types.js";

/**
 * Keyed registry of agent definitions (ADR-07 D3). A plain Map wrapper —
 * definitions register themselves by `key`; `runAgent` (pipeline.ts) takes a
 * definition directly, so the registry is a lookup convenience for callers
 * (e.g. a webhook/cron dispatcher resolving `agentKey` -> definition), not a
 * dependency of the pipeline itself.
 */
export class AgentRegistry {
  private readonly definitions = new Map<string, AgentDefinition<unknown, unknown>>();

  register<TInput, TOutput>(definition: AgentDefinition<TInput, TOutput>): void {
    if (this.definitions.has(definition.key)) {
      throw new Error(
        `AgentRegistry: an agent is already registered under key "${definition.key}"`,
      );
    }
    this.definitions.set(definition.key, definition as AgentDefinition<unknown, unknown>);
  }

  get(key: string): AgentDefinition<unknown, unknown> | undefined {
    return this.definitions.get(key);
  }

  list(): AgentDefinition<unknown, unknown>[] {
    return [...this.definitions.values()];
  }
}
