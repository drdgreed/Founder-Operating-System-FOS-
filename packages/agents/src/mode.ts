/**
 * Feature mode ladder (ADR-07 D8): shadow (runs, output not surfaced) ->
 * review (surfaced for founder approval) -> live (reserved; no autonomous
 * send/publish exists in any mode per invariant §9 — "live" is not wired to
 * any execution path in this slice).
 */
export const FEATURE_MODES = ["shadow", "review", "live"] as const;
export type FeatureMode = (typeof FEATURE_MODES)[number];

const MODE_RANK: Record<FeatureMode, number> = { shadow: 0, review: 1, live: 2 };

/**
 * Defense-in-depth (D3 `autonomyCeiling`): the EFFECTIVE mode a run operates
 * under is the lesser of the workspace's feature-flag mode and the agent
 * definition's coded autonomy ceiling. A flag misconfigured to "live" can
 * never push a run past what the versioned definition permits.
 */
export function effectiveMode(flagMode: FeatureMode, autonomyCeiling: FeatureMode): FeatureMode {
  return MODE_RANK[flagMode] <= MODE_RANK[autonomyCeiling] ? flagMode : autonomyCeiling;
}
