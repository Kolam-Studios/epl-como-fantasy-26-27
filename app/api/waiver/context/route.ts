// POST /api/waiver/context - step 1 of the waiver form: verify the (manager,
// token) pair and return the manager's remaining budget, squad, and any saved
// form for the current period. POST (not GET) so the token travels in a
// header, never a URL. A mismatched pair gets one generic rejection whichever
// half was wrong - this endpoint must not be usable to probe token existence.

import { NextResponse } from "next/server";
import { waiverContext } from "@/lib/waiver";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  try {
    const token = request.headers.get("x-manager-token") ?? "";
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "body must be JSON: {managerId}" },
        { status: 400, headers: NO_STORE },
      );
    }
    const { managerId } = (body ?? {}) as Record<string, unknown>;
    if (!Number.isInteger(managerId)) {
      return NextResponse.json(
        { error: "managerId must be a whole number" },
        { status: 400, headers: NO_STORE },
      );
    }

    const result = await waiverContext({ managerId: managerId as number, token });
    if (!result.ok) {
      const status = result.code === "no_match" ? 401 : 422;
      return NextResponse.json(result, { status, headers: NO_STORE });
    }
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (err) {
    console.error("POST /api/waiver/context failed:", err);
    return NextResponse.json({ error: "context lookup failed" }, { status: 500, headers: NO_STORE });
  }
}
