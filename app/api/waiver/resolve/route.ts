// POST /api/waiver/resolve - run the waiver engine on the current period.
// COMMISSIONER-GATED. Body: {dryRun?, seed?, force?}.
//   dryRun: compute and return the full outcome log WITHOUT writing anything
//           (the rehearsal mode for the Commissioners before 26 Sep).
//   seed:   optional explicit seed (rehearsals/replays); omitted = random,
//           and always published with the results.
//   force:  resolve before the cutoff (audited); never needed on the night.

import { NextResponse } from "next/server";
import { requireCommissioner } from "@/lib/auth";
import { getConfig } from "@/lib/config";
import { sql } from "@/lib/db";
import { resolveWaiverPeriod } from "@/lib/waiver-engine-core.mjs";

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
    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      // empty body = a plain real run
    }
    const result = await resolveWaiverPeriod(sql, getConfig(), {
      dryRun: body.dryRun === true,
      seed: typeof body.seed === "string" && body.seed.trim() !== "" ? body.seed : undefined,
      force: body.force === true,
      actor: "commissioner",
    });
    if (!result.ok) {
      return NextResponse.json(result, { status: 422, headers: NO_STORE });
    }
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (err) {
    console.error("POST /api/waiver/resolve failed:", err);
    return NextResponse.json({ error: "resolution failed" }, { status: 500, headers: NO_STORE });
  }
}
