/**
 * REAL-MODEL eval for the guarantee classifier (issue #106, Option C slice 1).
 *
 * Runs the FULL confirmed corpus (guarantee-corpus.ts) through
 * `evaluateGuaranteeText` against the REAL Anthropic model and reports
 * precision + recall, listing every misclassification. "block" is the positive
 * class (we are detecting prohibited employment-outcome guarantees), so:
 *   - RECALL FAILURE = a must-BLOCK entry the classifier ALLOWED. This is a HARD
 *     FAIL (a real guarantee reached the student) and is highlighted.
 *   - PRECISION MISS = a must-ALLOW entry the classifier BLOCKED (over-block of
 *     legitimate readiness copy). Undesirable but not a safety failure.
 *
 * SECURITY: the API key is read ONLY by AnthropicModelClient from
 * process.env.ANTHROPIC_API_KEY at call time — never printed, logged, or
 * embedded here. If the key is absent, the script prints a message and exits 0
 * (so CI / a keyless run is a no-op, not a failure).
 *
 * RUN:  ANTHROPIC_API_KEY=sk-... npx tsx packages/agents/src/gates/eval/guarantee-classifier-eval.ts
 */
import { AnthropicModelClient } from "../../model-client.js";
import { evaluateGuaranteeText } from "../guarantee-classifier.js";
import type { GuaranteeVerdict } from "../guarantee-classifier.js";
import { GUARANTEE_CORPUS } from "../__tests__/guarantee-corpus.js";

interface Row {
  text: string;
  expected: GuaranteeVerdict;
  predicted: GuaranteeVerdict;
  tier: string;
  reason: string;
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("ANTHROPIC_API_KEY not set — eval skipped");
    process.exit(0);
  }

  const model = new AnthropicModelClient({ fetchImpl: globalThis.fetch });
  const deps = { model };

  const rows: Row[] = [];
  for (const entry of GUARANTEE_CORPUS) {
    const decision = await evaluateGuaranteeText(entry.text, deps);
    rows.push({
      text: entry.text,
      expected: entry.expected,
      predicted: decision.verdict,
      tier: decision.tier,
      reason: decision.reason,
    });
  }

  // "block" = positive class.
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  const recallFailures: Row[] = [];
  const precisionMisses: Row[] = [];
  for (const r of rows) {
    if (r.expected === "block" && r.predicted === "block") tp++;
    else if (r.expected === "allow" && r.predicted === "block") {
      fp++;
      precisionMisses.push(r);
    } else if (r.expected === "block" && r.predicted === "allow") {
      fn++;
      recallFailures.push(r);
    } else tn++;
  }

  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);

  console.log("=== Guarantee classifier — real-model eval ===");
  console.log(`corpus size: ${rows.length}  (block=${tp + fn}, allow=${fp + tn})`);
  console.log(`confusion:   TP=${tp} FP=${fp} FN=${fn} TN=${tn}`);
  console.log(`precision:   ${(precision * 100).toFixed(1)}%`);
  console.log(`recall:      ${(recall * 100).toFixed(1)}%  (RECALL IS PARAMOUNT)`);
  console.log("");

  if (recallFailures.length > 0) {
    console.log(
      `### HARD FAIL — ${recallFailures.length} RECALL FAILURE(S): must-BLOCK allowed through ###`,
    );
    for (const r of recallFailures) {
      console.log(`  ALLOWED (should BLOCK): "${r.text}"  [tier=${r.tier}] — ${r.reason}`);
    }
    console.log("");
  } else {
    console.log("recall: no must-BLOCK entry was allowed. ✔");
    console.log("");
  }

  if (precisionMisses.length > 0) {
    console.log(
      `### ${precisionMisses.length} PRECISION MISS(ES): must-ALLOW over-blocked (readiness copy) ###`,
    );
    for (const r of precisionMisses) {
      console.log(`  BLOCKED (should ALLOW): "${r.text}"  [tier=${r.tier}] — ${r.reason}`);
    }
    console.log("");
  }

  // A recall failure is a hard fail — exit non-zero so CI / the owner notices.
  process.exit(recallFailures.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("eval crashed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
