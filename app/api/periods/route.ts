// GET /api/periods - the season phase list behind the two-level phase nav
// (docs/DESIGN-WAIVERS.md 2.1). Open read, no auth (war-room model). Never
// cached: a period's status can flip (locked -> open -> resolving -> closed)
// between reads. Pre-backfill this degrades to an empty list and every
// consumer (PhaseNav's fallback) renders the unchanged auction-era nav.

import { NextResponse } from "next/server";
import { getPeriodsPayload } from "@/lib/periods";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const payload = await getPeriodsPayload();
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    console.error("GET /api/periods failed:", err);
    return NextResponse.json(
      { error: "periods unavailable" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
