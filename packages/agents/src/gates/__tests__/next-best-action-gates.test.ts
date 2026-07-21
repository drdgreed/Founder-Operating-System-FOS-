import { describe, it, expect } from "vitest";
import { OPPORTUNITY_STAGES, OPPORTUNITY_TRANSITIONS } from "@fos/db/services";
import type { OpportunityStage } from "@fos/db/services";
import type { GateContext } from "../gate.js";
import { consentGate } from "../consent.js";
import { cooldownGate } from "../cooldown.js";
import { lifecycleLegalGate } from "../lifecycle-legal.js";
import { noDuplicateTaskGate, type ActionKey } from "../no-duplicate-task.js";
import { noScheduledActivityConflictGate } from "../no-scheduled-activity-conflict.js";
import { notTerminalStatusGate, TERMINAL_OPPORTUNITY_STAGES } from "../not-terminal-status.js";
import { offerAvailableGate } from "../offer-available.js";

interface FakeInput {
  currentStage: OpportunityStage;
  now: string;
  consentedChannels: string[];
  cooldownUntil: string | null;
  existingOpenActions: ActionKey[];
  scheduledActivities: ActionKey[];
  availableOffers: string[];
  allowedActionsByStage: Readonly<Record<OpportunityStage, readonly string[]>>;
}

interface FakeOutput {
  actionType: string;
  actionTarget: string;
  channel?: string;
  isContact: boolean;
  impliedStage?: OpportunityStage;
  offer: string;
}

const DEFAULT_ALLOWED_ACTIONS_BY_STAGE: Readonly<Record<OpportunityStage, readonly string[]>> = {
  new_lead: [],
  reviewing: [],
  contacted: ["send_follow_up_email"],
  conversation_scheduled: [],
  conversation_completed: [],
  offered: [],
  enrolled: [],
  declined: [],
  deferred: [],
  unresponsive: [],
  disqualified: [],
};

function ctx(
  input: Partial<FakeInput>,
  output: Partial<FakeOutput>,
): GateContext<FakeInput, FakeOutput> {
  return {
    workspaceId: "ws-1",
    agentKey: "fos.next_best_action",
    mode: "shadow",
    input: {
      currentStage: "contacted",
      now: "2026-01-10T00:00:00.000Z",
      consentedChannels: [],
      cooldownUntil: null,
      existingOpenActions: [],
      scheduledActivities: [],
      availableOffers: [],
      allowedActionsByStage: DEFAULT_ALLOWED_ACTIONS_BY_STAGE,
      ...input,
    },
    output: {
      actionType: "send_follow_up_email",
      actionTarget: "person-1",
      isContact: true,
      offer: "cohort-2026-a",
      ...output,
    },
  };
}

describe("FOS1-NBA-GATE-consent", () => {
  // FOUNDER DECISION (issue #78): consent is OPTION B — opt-in / fail-closed.
  // A proposed contact's channel must be AFFIRMATIVELY in the allowlist;
  // absent/empty/unknown consent BLOCKS. This replaces the #77 denylist
  // ("option A") shape — see gates/consent.ts file header.
  const gate = consentGate<FakeInput, FakeOutput>({
    key: "fos.next_best_action.consent",
    selectProposedActionChannel: (output) => output.channel,
    selectConsentedChannels: (input) => input.consentedChannels,
  });

  it("ALLOW: channel is affirmatively in the consented-channel allowlist", async () => {
    const result = await gate.evaluate(
      ctx({ consentedChannels: ["email", "sms"] }, { channel: "email" }),
    );
    expect(result.allowed).toBe(true);
  });

  it("BLOCK: channel is not in the consented-channel allowlist", async () => {
    const result = await gate.evaluate(ctx({ consentedChannels: ["sms"] }, { channel: "email" }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/no recorded consent/);
  });

  it("DECISIVE (option B, fail-closed): UNKNOWN/ABSENT consent for the channel BLOCKS the contact — an empty consentedChannels set never defaults to allowed", async () => {
    const result = await gate.evaluate(ctx({ consentedChannels: [] }, { channel: "email" }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/no recorded consent/);
  });

  it("edge: action with no channel (e.g. internal task) is always allowed, even with no consent recorded", async () => {
    const result = await gate.evaluate(ctx({ consentedChannels: [] }, { channel: undefined }));
    expect(result.allowed).toBe(true);
  });

  it("edge: consent recorded for a DIFFERENT channel does not extend to the proposed channel", async () => {
    const result = await gate.evaluate(ctx({ consentedChannels: ["sms"] }, { channel: "phone" }));
    expect(result.allowed).toBe(false);
  });
});

describe("FOS1-NBA-GATE-cooldown", () => {
  const gate = cooldownGate<FakeInput, FakeOutput>({
    key: "fos.next_best_action.cooldown",
    selectIsContactAction: (output) => output.isContact,
    selectNow: (input) => input.now,
    selectCooldownUntil: (input) => input.cooldownUntil,
  });

  it("ALLOW: now is after cooldownUntil", async () => {
    const result = await gate.evaluate(
      ctx(
        { now: "2026-01-10T00:00:00.000Z", cooldownUntil: "2026-01-05T00:00:00.000Z" },
        { isContact: true },
      ),
    );
    expect(result.allowed).toBe(true);
  });

  it("BLOCK: now is before cooldownUntil for a contact action", async () => {
    const result = await gate.evaluate(
      ctx(
        { now: "2026-01-01T00:00:00.000Z", cooldownUntil: "2026-01-05T00:00:00.000Z" },
        { isContact: true },
      ),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/cooldown active/);
  });

  it("edge: non-contact action is always allowed, even inside an active cooldown", async () => {
    const result = await gate.evaluate(
      ctx(
        { now: "2026-01-01T00:00:00.000Z", cooldownUntil: "2026-01-05T00:00:00.000Z" },
        { isContact: false },
      ),
    );
    expect(result.allowed).toBe(true);
  });

  it("edge: cooldown boundary — now exactly equal to cooldownUntil is allowed (elapsed)", async () => {
    const boundary = "2026-01-05T00:00:00.000Z";
    const result = await gate.evaluate(
      ctx({ now: boundary, cooldownUntil: boundary }, { isContact: true }),
    );
    expect(result.allowed).toBe(true);
  });

  it("edge: absent cooldownUntil means no cooldown in effect", async () => {
    const result = await gate.evaluate(
      ctx({ now: "2026-01-01T00:00:00.000Z", cooldownUntil: null }, { isContact: true }),
    );
    expect(result.allowed).toBe(true);
  });

  it("FAIL-CLOSED: a malformed `now` BLOCKS the contact (does not silently allow via NaN)", async () => {
    const result = await gate.evaluate(
      ctx(
        { now: "not-a-real-date", cooldownUntil: "2026-01-05T00:00:00.000Z" },
        { isContact: true },
      ),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/invalid time input/);
  });

  it("FAIL-CLOSED: a present-but-malformed `cooldownUntil` BLOCKS the contact", async () => {
    const result = await gate.evaluate(
      ctx({ now: "2026-01-10T00:00:00.000Z", cooldownUntil: "garbage" }, { isContact: true }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/invalid time input/);
  });
});

describe("FOS1-NBA-GATE-lifecycle-legal", () => {
  // FLAG (issue #78): allowedActionsByStage is caller-supplied per-run input
  // (selector), not a value fixed at gate-construction time — see
  // gates/lifecycle-legal.ts file header.
  const gate = lifecycleLegalGate<FakeInput, FakeOutput>({
    key: "fos.next_best_action.lifecycle-legal",
    selectCurrentStage: (input) => input.currentStage,
    selectProposedActionType: (output) => output.actionType,
    selectImpliedStage: (output) => output.impliedStage,
    selectAllowedActionsByStage: (input) => input.allowedActionsByStage,
  });

  it("ALLOW: action type is permitted at the current stage (no implied stage move)", async () => {
    const result = await gate.evaluate(
      ctx({ currentStage: "contacted" }, { actionType: "send_follow_up_email" }),
    );
    expect(result.allowed).toBe(true);
  });

  it("BLOCK: action type is not permitted at the current stage", async () => {
    const result = await gate.evaluate(
      ctx({ currentStage: "new_lead" }, { actionType: "send_follow_up_email" }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/not permitted at stage/);
  });

  it("ALLOW: implied stage move is a legal transition", async () => {
    const result = await gate.evaluate(
      ctx(
        { currentStage: "contacted" },
        { actionType: "propose_offer", impliedStage: "conversation_scheduled" },
      ),
    );
    expect(result.allowed).toBe(true);
  });

  it("BLOCK: implied stage move is an illegal transition", async () => {
    const result = await gate.evaluate(
      ctx({ currentStage: "new_lead" }, { actionType: "enroll", impliedStage: "enrolled" }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/illegal stage transition/);
  });

  it("edge: stage with no allowed actions blocks every non-stage-move action", async () => {
    const result = await gate.evaluate(
      ctx({ currentStage: "reviewing" }, { actionType: "send_follow_up_email" }),
    );
    expect(result.allowed).toBe(false);
  });
});

describe("FOS1-NBA-GATE-no-duplicate-task", () => {
  const gate = noDuplicateTaskGate<FakeInput, FakeOutput>({
    key: "fos.next_best_action.no-duplicate-task",
    selectProposedAction: (output) => ({ type: output.actionType, target: output.actionTarget }),
    selectExistingOpenActions: (input) => input.existingOpenActions,
  });

  it("ALLOW: no existing open action matches", async () => {
    const result = await gate.evaluate(
      ctx(
        { existingOpenActions: [{ type: "send_follow_up_email", target: "person-2" }] },
        { actionType: "send_follow_up_email", actionTarget: "person-1" },
      ),
    );
    expect(result.allowed).toBe(true);
  });

  it("BLOCK: an exact type+target match already exists as an open action", async () => {
    const result = await gate.evaluate(
      ctx(
        { existingOpenActions: [{ type: "send_follow_up_email", target: "person-1" }] },
        { actionType: "send_follow_up_email", actionTarget: "person-1" },
      ),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/duplicate of an existing open action/);
  });

  it("edge: empty existing-action set always allows", async () => {
    const result = await gate.evaluate(
      ctx(
        { existingOpenActions: [] },
        { actionType: "send_follow_up_email", actionTarget: "person-1" },
      ),
    );
    expect(result.allowed).toBe(true);
  });

  it("edge: same type but different target is not a duplicate", async () => {
    const result = await gate.evaluate(
      ctx(
        { existingOpenActions: [{ type: "send_follow_up_email", target: "person-2" }] },
        { actionType: "send_follow_up_email", actionTarget: "person-1" },
      ),
    );
    expect(result.allowed).toBe(true);
  });
});

describe("FOS1-NBA-GATE-no-scheduled-activity-conflict", () => {
  const gate = noScheduledActivityConflictGate<FakeInput, FakeOutput>({
    key: "fos.next_best_action.no-scheduled-activity-conflict",
    selectProposedAction: (output) => ({ type: output.actionType, target: output.actionTarget }),
    selectScheduledActivities: (input) => input.scheduledActivities,
  });

  it("ALLOW: no scheduled activity matches the proposed action", async () => {
    const result = await gate.evaluate(
      ctx(
        { scheduledActivities: [{ type: "schedule_conversation", target: "person-2" }] },
        { actionType: "schedule_conversation", actionTarget: "person-1" },
      ),
    );
    expect(result.allowed).toBe(true);
  });

  it("BLOCK: proposed action is already covered by a scheduled future activity", async () => {
    const result = await gate.evaluate(
      ctx(
        { scheduledActivities: [{ type: "schedule_conversation", target: "person-1" }] },
        { actionType: "schedule_conversation", actionTarget: "person-1" },
      ),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/already-scheduled future activity/);
  });

  it("edge: empty scheduled-activity set always allows", async () => {
    const result = await gate.evaluate(
      ctx(
        { scheduledActivities: [] },
        { actionType: "schedule_conversation", actionTarget: "person-1" },
      ),
    );
    expect(result.allowed).toBe(true);
  });
});

describe("FOS1-NBA-GATE-not-terminal-status", () => {
  const gate = notTerminalStatusGate<FakeInput, FakeOutput>({
    key: "fos.next_best_action.not-terminal-status",
    selectCurrentStage: (input) => input.currentStage,
  });

  it("ALLOW: opportunity is in a non-terminal stage", async () => {
    const result = await gate.evaluate(ctx({ currentStage: "contacted" }, {}));
    expect(result.allowed).toBe(true);
  });

  it("BLOCK: opportunity is in a terminal stage", async () => {
    const result = await gate.evaluate(ctx({ currentStage: "enrolled" }, {}));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/terminal stage/);
  });

  it("edge: terminal-set derivation matches the §12.1 matrix exactly — stages with zero outgoing edges", async () => {
    const derived = new Set(
      OPPORTUNITY_STAGES.filter((stage) => OPPORTUNITY_TRANSITIONS[stage].length === 0),
    );
    expect(TERMINAL_OPPORTUNITY_STAGES).toEqual(derived);
    expect([...TERMINAL_OPPORTUNITY_STAGES].sort()).toEqual(
      ["declined", "disqualified", "enrolled"].sort(),
    );
  });

  it("edge: every non-terminal stage has at least one legal outgoing edge and is allowed", async () => {
    for (const stage of OPPORTUNITY_STAGES) {
      if (TERMINAL_OPPORTUNITY_STAGES.has(stage)) continue;
      expect(OPPORTUNITY_TRANSITIONS[stage].length).toBeGreaterThan(0);
      const result = await gate.evaluate(ctx({ currentStage: stage }, {}));
      expect(result.allowed).toBe(true);
    }
  });
});

describe("FOS1-NBA-GATE-offer-available", () => {
  const gate = offerAvailableGate<FakeInput, FakeOutput>({
    key: "fos.next_best_action.offer-available",
    selectProposedOffer: (output) => output.offer,
    selectAvailableOffers: (input) => input.availableOffers,
    undeterminedValue: "undetermined",
  });

  it("ALLOW: proposed offer is in the available-offer set", async () => {
    const result = await gate.evaluate(
      ctx({ availableOffers: ["cohort-2026-a"] }, { offer: "cohort-2026-a" }),
    );
    expect(result.allowed).toBe(true);
  });

  it("BLOCK: proposed offer is not in the available-offer set", async () => {
    const result = await gate.evaluate(
      ctx({ availableOffers: ["cohort-2026-a"] }, { offer: "cohort-2026-b" }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/offer "cohort-2026-b" is not in the available offer set/);
  });

  it("edge: undetermined sentinel is allowed unconditionally, even against an empty available set", async () => {
    const result = await gate.evaluate(ctx({ availableOffers: [] }, { offer: "undetermined" }));
    expect(result.allowed).toBe(true);
  });
});
