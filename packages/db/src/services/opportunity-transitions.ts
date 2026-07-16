/**
 * Opportunity state machine (spec §12.1) encoded as DATA. Transcribed
 * verbatim from §12.1's full transition table:
 *
 *   new_lead                -> reviewing, disqualified
 *   reviewing                -> contacted, deferred, disqualified
 *   contacted                 -> conversation_scheduled, deferred, unresponsive, declined
 *   conversation_scheduled     -> conversation_completed, contacted, unresponsive
 *   conversation_completed     -> offered, contacted, deferred, declined, disqualified
 *   offered                   -> enrolled, declined, deferred, unresponsive
 *   deferred                  -> reviewing, contacted, conversation_scheduled, declined
 *   unresponsive               -> contacted, conversation_scheduled, declined
 *   enrolled, declined, disqualified -> (terminal; §12.1 lists no outgoing edges)
 *
 * 28 legal edges across 11 states. Any (from, to) pair not listed here
 * (including self-transitions, which §12.1 never lists) is illegal.
 */
export const OPPORTUNITY_STAGES = [
  "new_lead",
  "reviewing",
  "contacted",
  "conversation_scheduled",
  "conversation_completed",
  "offered",
  "enrolled",
  "declined",
  "deferred",
  "unresponsive",
  "disqualified",
] as const;

export type OpportunityStage = (typeof OPPORTUNITY_STAGES)[number];

export const OPPORTUNITY_TRANSITIONS: Record<OpportunityStage, readonly OpportunityStage[]> = {
  new_lead: ["reviewing", "disqualified"],
  reviewing: ["contacted", "deferred", "disqualified"],
  contacted: ["conversation_scheduled", "deferred", "unresponsive", "declined"],
  conversation_scheduled: ["conversation_completed", "contacted", "unresponsive"],
  conversation_completed: ["offered", "contacted", "deferred", "declined", "disqualified"],
  offered: ["enrolled", "declined", "deferred", "unresponsive"],
  enrolled: [],
  declined: [],
  deferred: ["reviewing", "contacted", "conversation_scheduled", "declined"],
  unresponsive: ["contacted", "conversation_scheduled", "declined"],
  disqualified: [],
};

export function isLegalTransition(from: OpportunityStage, to: OpportunityStage): boolean {
  return OPPORTUNITY_TRANSITIONS[from].includes(to);
}

/** Every legal (from, to) edge — used by tests to cover 100% of the matrix. */
export const LEGAL_EDGES: Array<[OpportunityStage, OpportunityStage]> = OPPORTUNITY_STAGES.flatMap(
  (from) =>
    OPPORTUNITY_TRANSITIONS[from].map((to) => [from, to] as [OpportunityStage, OpportunityStage]),
);

/** Every (from, to) pair NOT in the legal set, including self-transitions. */
export const ILLEGAL_EDGES: Array<[OpportunityStage, OpportunityStage]> =
  OPPORTUNITY_STAGES.flatMap((from) =>
    OPPORTUNITY_STAGES.filter((to) => !isLegalTransition(from, to)).map(
      (to) => [from, to] as [OpportunityStage, OpportunityStage],
    ),
  );
