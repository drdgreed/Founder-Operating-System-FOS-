import { NextRequest, NextResponse } from "next/server";
import {
  transitionOpportunity,
  IllegalTransitionError,
  StaleVersionError,
  OpportunityNotFoundError,
  type OpportunityStage,
} from "@fos/db/services";
import { getDb } from "../../../../../../lib/db.js";

/**
 * `POST /api/fos/opportunities/:opportunityId/transition` (spec §15.8, §12.1).
 *
 * Thin wrapper over the transition service (`@fos/db/services`) — this
 * slice's done-condition is proven at the service layer (see
 * `packages/db/src/services/__tests__/opportunity-transition.test.ts`), not
 * through this route.
 */
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  let body: {
    to_stage: OpportunityStage;
    expected_version: number;
    actor: { type: string; id: string };
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    const result = await transitionOpportunity(getDb(), {
      opportunityId: id,
      toStage: body.to_stage,
      expectedVersion: body.expected_version,
      actor: body.actor as { type: "founder" | "agent" | "provider" | "system"; id: string },
    });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof StaleVersionError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof IllegalTransitionError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    if (err instanceof OpportunityNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
