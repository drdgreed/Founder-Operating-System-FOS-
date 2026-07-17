import { NextRequest, NextResponse } from "next/server";
import { getDb } from "../../../../../../lib/db.js";
import {
  requireServiceAuth,
  UnauthorizedError,
  ServiceUnconfiguredError,
  type Principal,
} from "../../../../../../lib/auth.js";
import { handleTransition } from "../../../../../../lib/handlers.js";

/**
 * `POST /api/fos/opportunities/:id/transition` (spec §15.8, §12.1). Thin
 * adapter: authenticate → parse JSON → delegate to `handleTransition`. The
 * actor is bound from the authenticated principal (never the body), and the
 * target opportunity is tenant-scoped to the principal's workspace.
 */
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  let principal: Principal;
  try {
    principal = requireServiceAuth(req);
  } catch (err) {
    if (err instanceof ServiceUnconfiguredError) {
      return NextResponse.json({ error: "service unavailable" }, { status: 503 });
    }
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const result = await handleTransition(getDb(), principal, id, raw);
  return NextResponse.json(result.body, { status: result.status });
}
