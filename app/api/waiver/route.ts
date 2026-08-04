// POST /api/waiver - submit (or resubmit) a manager's blind-bid waiver form.
// This is the platform's first NON-commissioner write: gated by the manager's
// own token in the X-Manager-Token header, never COMMISSIONER_TOKEN. Every
// rule is enforced server-side (lib/waiver-core.mjs); the response never
// reveals whether a token exists, and no read payload ever carries a
// submission until the round resolves.

import { NextResponse } from "next/server";
import { submitWaiverForm } from "@/lib/waiver";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  try {
    const token = request.headers.get("x-manager-token") ?? "";
    if (token.trim() === "") {
      return NextResponse.json(
        { ok: false, code: "no_token", message: "X-Manager-Token header required." },
        { status: 401, headers: NO_STORE },
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "body must be JSON: {managerId, drops: [{playerId}], bids: [{playerId, amount}]}" },
        { status: 400, headers: NO_STORE },
      );
    }
    const { managerId, drops, bids } = (body ?? {}) as Record<string, unknown>;
    if (!Number.isInteger(managerId)) {
      return NextResponse.json(
        { error: "managerId must be a whole number" },
        { status: 400, headers: NO_STORE },
      );
    }

    const result = await submitWaiverForm({
      managerId: managerId as number,
      token,
      drops: (drops ?? []) as Array<{ playerId: number }>,
      bids: (bids ?? []) as Array<{ playerId: number; amount: number }>,
      actor: "manager",
    });

    if (!result.ok) {
      const status = result.code === "no_match" ? 401 : 422;
      return NextResponse.json(result, { status, headers: NO_STORE });
    }
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (err) {
    console.error("POST /api/waiver failed:", err);
    return NextResponse.json({ error: "waiver submission failed" }, { status: 500, headers: NO_STORE });
  }
}
