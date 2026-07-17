import { NextRequest, NextResponse } from "next/server";
import { getDb } from "../../../../../lib/db.js";
import {
  requireServiceAuth,
  UnauthorizedError,
  ServiceUnconfiguredError,
  type Principal,
} from "../../../../../lib/auth.js";
import { handleIntake } from "../../../../../lib/handlers.js";

/**
 * `POST /api/fos/applications/intake` (spec §15.8). Thin adapter:
 * authenticate → parse JSON → delegate to `handleIntake`. The actor and
 * workspace are bound from the authenticated principal, never from the body;
 * the done-condition (and its security regression tests) live at the handler
 * layer (`apps/api/lib/handlers.ts`, `apps/api/test`).
 */
export async function POST(req: NextRequest) {
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

  const result = await handleIntake(getDb(), principal, raw);
  return NextResponse.json(result.body, { status: result.status });
}
