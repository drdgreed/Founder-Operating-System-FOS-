import { NextRequest, NextResponse } from "next/server";
import { intakeApplication, type IntakeInput } from "@fos/db/services";
import { getDb } from "../../../../../lib/db.js";

/**
 * `POST /api/fos/applications/intake` (spec §15.8).
 *
 * Thin wrapper over the intake service (`@fos/db/services`) — this slice's
 * done-condition is proven at the service layer (see
 * `packages/db/src/services/__tests__`), not through this route. No
 * validation/authorization beyond what the service already enforces is
 * added here; that is out of scope for 0.1a.
 */
export async function POST(req: NextRequest) {
  let body: IntakeInput;
  try {
    body = (await req.json()) as IntakeInput;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    const result = await intakeApplication(getDb(), body);
    return NextResponse.json(result, { status: result.deduped ? 200 : 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
