// POST /api/manager/sit-out - toggle a manager's season sit-out flag
// (mockup H item 2). COMMISSIONER-GATED. Body: {managerId, satOut}.

import { NextResponse } from "next/server";
import { requireCommissioner } from "@/lib/auth";
import { getConfig } from "@/lib/config";
import { sql } from "@/lib/db";
import { setSatOut } from "@/lib/managers-core.mjs";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  try {
    if (!requireCommissioner(request)) {
      return NextResponse.json(
        { error: "commissioner token required" },
        { status: 401, headers: NO_STORE },
      );
    }
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json(
        { error: "body must be JSON: {managerId, satOut}" },
        { status: 400, headers: NO_STORE },
      );
    }
    const result = await setSatOut(sql, getConfig(), {
      managerId: body.managerId as number,
      satOut: body.satOut as boolean,
      actor: "commissioner",
    });
    if (!result.ok) return NextResponse.json(result, { status: 422, headers: NO_STORE });
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (err) {
    console.error("POST /api/manager/sit-out failed:", err);
    return NextResponse.json({ error: "sit-out toggle failed" }, { status: 500, headers: NO_STORE });
  }
}
