import { z } from "zod";
import type { ModelClient } from "../model-client.js";
import { DEFAULT_MODEL } from "../model-client.js";
import { zodToJsonSchema } from "../schema-to-json.js";

// ===========================================================================
// SAFETY-CRITICAL: semantic guarantee classifier (issue #106, Option C slice 1)
//
// THE COMPLIANCE CONTRACT (encoded verbatim in GUARANTEE_CLASSIFIER_SYSTEM_PROMPT
// below): Career Foundry MAY guarantee READINESS/PREPARATION — outcomes the
// PROGRAM controls, about the student's own capability. It may NOT guarantee
// EMPLOYMENT OUTCOMES — outcomes a third-party EMPLOYER controls.
//
// THE LOAD-BEARING BOUNDARY: the same word flips by MEANING.
//   "interview" = practice/readiness (ALLOW)  vs.  getting an interview (BLOCK)
//   "job-ready" (ALLOW)                        vs.  "get you a job" (BLOCK)
// A pure regex cannot see meaning, so this is a two-tier design:
//   Tier 1 — a NARROWED deterministic floor that hard-blocks ONLY the
//            unambiguous employment-OUTCOME guarantees that can NEVER be
//            readiness. It survives a total model failure. It deliberately does
//            NOT try to catch the subtle cases (that is Tier 2's job) and it
//            deliberately EXCLUDES every readiness phrasing.
//   Tier 2 — a semantic model classifier that reads meaning, for everything the
//            floor lets past.
//
// RECALL IS PARAMOUNT. Never let a real outcome guarantee through. On ANY
// doubt — a thrown error, a timeout, a schema-invalid response, a low-confidence
// verdict, or genuine ambiguity — we FAIL CLOSED (BLOCK).
// ===========================================================================

export type GuaranteeVerdict = "allow" | "block";

export interface GuaranteeDecision {
  verdict: GuaranteeVerdict;
  reason: string;
}

export interface GuaranteeDecisionWithTier extends GuaranteeDecision {
  /** Which tier produced the decision: the deterministic floor, the semantic
   * classifier, or an internal error path (which always fails closed). */
  tier: "tier1-floor" | "tier2-classifier";
}

export interface GuaranteeClassifierDeps {
  /** Injected model client — hermetic tests supply a FakeModelClient; no real
   * Anthropic call can occur unless the caller passes AnthropicModelClient. */
  model: ModelClient;
  /** Overridable model tier. Defaults to the capable Sonnet tier for recall. */
  modelName?: string;
  /** Wall-clock budget for the model call. On expiry we FAIL CLOSED. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Tier 1 — deterministic floor (hard block, NO model call).
//
// A NARROWED subset of no-prohibited-guarantee.ts. It matches ONLY unambiguous
// employment-OUTCOME guarantees built from an explicit acquisition construction
// (guarantee / promise-you / get|land|place|secure you a <employment noun> /
// (get you) hired / hire you). It DELIBERATELY EXCLUDES every readiness
// phrasing — "job-ready", "interview-ready", "market-ready", "prepared",
// "practiced", "ready to interview" — because those are ALLOWED and only Tier 2
// can adjudicate the ambiguous middle.
//
// ReDoS: every proximity window is bounded (`[^.!?]{0,40}`); no nested unbounded
// quantifier; all alternations are single-token. Linear.
// ---------------------------------------------------------------------------

// Reject the readiness compounds so the floor never fires on an ALLOWED phrase:
// "job-ready", "job ready", "interview-ready", "interview ready".
const READY_GUARD = "(?![-\\s]?ready)";

// Unambiguous employment-OUTCOME nouns (third-party-employer controlled). Each
// readiness-prone noun carries the READY_GUARD. "interviewing" is already
// excluded by the trailing `\b` in the patterns (no word boundary before "ing").
const FLOOR_SUBJECT =
  `(?:jobs?${READY_GUARD}|interviews?${READY_GUARD}|offers?|salary|salaries|` +
  `roles?|positions?|placements?|employment)`;

// "guarantee"/"guarantees"/"guaranteed"/"guaranteeing" — a guarantee next to any
// employment noun is never readiness.
const GUARANTEE_VERB = "(?:guarantee[sd]?|guaranteeing)";
// "promise" only ever fires here in the DIRECT 2nd-person "promise you a <noun>"
// construction — an unambiguous personal outcome promise.
const PROMISE_VERB = "(?:promise[sd]?|promising)";
// Acquisition verbs — "get/land/place/secure you a <noun>". Readiness copy never
// uses these against an employment noun.
const ACQUIRE_VERB = "(?:gets?|getting|got|lands?|landing|places?|placing|secures?|securing)";
// Contracted or plain future: "will" / "…'ll".
const WILL = "(?:\\bwill|'ll)";
// Optional article, including the definite one — "get you the job".
const ARTICLE = "(?:an?|the)\\s+";

const TIER1_FLOOR_PATTERNS: RegExp[] = [
  // 1a/1b. "guarantee" near an employment noun, either order, bounded window.
  //   "we guarantee you a job", "guaranteed employment on completion",
  //   "guaranteed interviews with employers", "a guaranteed $90k salary",
  //   "guaranteed placement", "guaranteed job offer".
  new RegExp(`\\b${GUARANTEE_VERB}\\b[^.!?]{0,40}\\b${FLOOR_SUBJECT}\\b`, "i"),
  new RegExp(`\\b${FLOOR_SUBJECT}\\b[^.!?]{0,40}\\b${GUARANTEE_VERB}\\b`, "i"),
  // 2. Direct 2nd-person "promise you a <noun>".
  //   "we promise you a role at a partner company", "promise you a $90k salary".
  new RegExp(`\\b${PROMISE_VERB}\\s+you\\s+(?:${ARTICLE})?${FLOOR_SUBJECT}\\b`, "i"),
  // 3. Acquisition verb + you + (article) + noun.
  //   "we'll get you an interview", "get you the job".
  new RegExp(`\\b${ACQUIRE_VERB}\\s+you\\s+(?:${ARTICLE})?${FLOOR_SUBJECT}\\b`, "i"),
  // 4. will/'ll + acquisition verb + (you) + (article) + noun.
  //   "you'll land a job in 90 days", "we'll land you a job at a top company".
  new RegExp(
    `${WILL}\\s+(?:definitely\\s+|certainly\\s+)?${ACQUIRE_VERB}\\s+(?:you\\s+)?(?:${ARTICLE})?${FLOOR_SUBJECT}\\b`,
    "i",
  ),
  // 5. "(will) get/... you hired" — "hired" is not a noun subject, its own arm.
  //   "we'll get you hired", "get you hired".
  new RegExp(`(?:${WILL}\\s+)?${ACQUIRE_VERB}\\s+you\\s+hired\\b`, "i"),
  // 6. "guaranteed hired" / "guaranteed to be hired".
  new RegExp(`\\b${GUARANTEE_VERB}\\s+(?:you\\s+)?(?:to\\s+be\\s+)?hired\\b`, "i"),
  // 7. Transitive "hire you" employment promise ("the firm will hire you").
  new RegExp(`\\bhir(?:e|es|ing)\\s+you\\b`, "i"),
];

// Normalize curly/smart apostrophes to ASCII "'" so the "'ll" arms match
// ordinary LLM output (curly quotes are the default there). Linear replace.
function normalizeForMatch(text: string): string {
  return text.replace(/[’ʼ]/g, "'");
}

/**
 * Tier 1: returns the matching pattern's block decision, or null if the floor
 * does not fire (→ escalate to Tier 2). Pure, synchronous, no model call.
 */
export function tier1FloorBlock(text: string): GuaranteeDecision | null {
  const normalized = normalizeForMatch(text);
  for (const pattern of TIER1_FLOOR_PATTERNS) {
    if (pattern.test(normalized)) {
      return {
        verdict: "block",
        reason: `tier-1 floor: unambiguous employment-outcome guarantee detected: "${text}"`,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tier 2 — semantic classifier (structured-output model call, FAILS CLOSED).
// ---------------------------------------------------------------------------

// The policy, encoded VERBATIM. Tests assert these phrases reach the model.
export const GUARANTEE_CLASSIFIER_SYSTEM_PROMPT = `You are a SAFETY-CRITICAL compliance classifier for Career Foundry, a career-training program. You decide whether one piece of student-facing marketing or coaching copy makes a PROHIBITED guarantee.

THE POLICY (the contract):
Career Foundry MAY guarantee READINESS / PREPARATION — outcomes the PROGRAM controls, about the student's OWN capability. It MAY NOT guarantee EMPLOYMENT OUTCOMES — outcomes a third-party EMPLOYER controls.

ALLOWED (readiness — verdict "allow"):
- job-ready / market-ready skills
- "prepared to enter the market"
- an employer-ready LinkedIn & resume
- a portfolio that evidences / proves expertise
- interview-READY / "well-practiced at interviewing"
- "prepared for interviews"

PROHIBITED (outcome guarantee — verdict "block"):
- guaranteeing an actual job
- an interview WITH AN EMPLOYER (an acquired interview, not practice)
- a salary / compensation figure
- being hired
- placement
- a role at a company

THE LOAD-BEARING BOUNDARY — the SAME WORD flips by MEANING:
- "interview" as PRACTICE ("well-practiced at interviewing", "interview-ready") = ALLOW; "interview" as something ACQUIRED FROM AN EMPLOYER ("we'll get you an interview") = BLOCK.
- "job-ready" (a capability) = ALLOW; "get you a job" (an acquired outcome) = BLOCK.

RECALL IS PARAMOUNT: NEVER let a real employment-outcome guarantee through. On GENUINE AMBIGUITY, BLOCK (fail closed) and report confidence "low".

Return: verdict ("allow" or "block"), confidence ("high" or "low"), and a one-sentence reason. Use confidence "low" whenever you are uncertain, ambiguous, or the text is out of scope — anything less than a clear, confident "allow" must be reported as low confidence so the system can fail closed.`;

const ClassifierOutputSchema = z.object({
  verdict: z.enum(["allow", "block"]),
  confidence: z.enum(["high", "low"]),
  reason: z.string().min(1),
});

const CLASSIFIER_OUTPUT_JSON_SCHEMA = zodToJsonSchema(ClassifierOutputSchema);

class TimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new TimeoutError(`guarantee classifier model call exceeded ${timeoutMs}ms`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Tier 2 semantic classifier. Makes a structured-output model call that encodes
 * the policy verbatim. FAILS CLOSED: any thrown error, timeout, schema-invalid
 * response, or a low-confidence / non-confident-allow result → BLOCK.
 *
 * NOTE: this NEVER re-throws — a safety classifier that throws is a safety
 * classifier that can be bypassed by an unhandled rejection. Every failure
 * path returns a BLOCK decision.
 */
export async function classifyGuarantee(
  text: string,
  deps: GuaranteeClassifierDeps,
): Promise<GuaranteeDecision> {
  const modelName = deps.modelName ?? DEFAULT_MODEL;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let raw: unknown;
  try {
    const result = await withTimeout(
      deps.model.generateStructured({
        systemPrompt: GUARANTEE_CLASSIFIER_SYSTEM_PROMPT,
        userContent: `Classify this student-facing copy:\n\n"""${text}"""`,
        outputJsonSchema: CLASSIFIER_OUTPUT_JSON_SCHEMA,
        model: modelName,
      }),
      timeoutMs,
    );
    raw = result.output;
  } catch (err) {
    const kind = err instanceof TimeoutError ? "timeout" : "error";
    return {
      verdict: "block",
      reason: `tier-2 fail-closed (${kind}): classifier call did not return a verdict`,
    };
  }

  const parsed = ClassifierOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      verdict: "block",
      reason:
        "tier-2 fail-closed (schema-invalid): classifier response did not match the output schema",
    };
  }

  const { verdict, confidence, reason } = parsed.data;

  // Fail closed on anything short of a CONFIDENT allow. A block at any
  // confidence stays a block; a low-confidence allow becomes a block.
  if (verdict === "allow" && confidence === "high") {
    return { verdict: "allow", reason };
  }
  if (verdict === "block") {
    return { verdict: "block", reason };
  }
  return {
    verdict: "block",
    reason: `tier-2 fail-closed (low-confidence): uncertain "${verdict}" verdict treated as block — ${reason}`,
  };
}

/**
 * Combined evaluation. Tier 1 first (block immediately if the floor matches, no
 * model call); otherwise Tier 2. Fail-closed throughout — any unexpected
 * exception is caught and returned as a BLOCK.
 */
export async function evaluateGuaranteeText(
  text: string,
  deps: GuaranteeClassifierDeps,
): Promise<GuaranteeDecisionWithTier> {
  try {
    const floor = tier1FloorBlock(text);
    if (floor) {
      return { ...floor, tier: "tier1-floor" };
    }
    const decision = await classifyGuarantee(text, deps);
    return { ...decision, tier: "tier2-classifier" };
  } catch (err) {
    // Defense in depth: classifyGuarantee already fails closed, but if any
    // future code path here throws, we STILL block.
    const message = err instanceof Error ? err.message : "unknown error";
    return {
      verdict: "block",
      reason: `fail-closed (unexpected error): ${message}`,
      tier: "tier2-classifier",
    };
  }
}
