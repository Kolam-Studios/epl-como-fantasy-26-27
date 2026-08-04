// GET /api/period/:seq - one season phase by its seq number, with its frozen
// archive snapshot when the period is closed (docs/DESIGN-WAIVERS.md 2.2).
// Open read, no auth (war-room model). Never cached: a period's status or
// snapshot can change between reads. Follows the app/api/player/[id] dynamic-
// segment pattern.

import { NextResponse } from "next/server";
import { getPeriodBySeq } from "@/lib/periods";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

type RouteContext = { params: Promise<{ seq: string }> };

/** Parse the :seq segment as a positive integer, or null. */
async function seqFrom(context: RouteContext): Promise<number | null> {
  const { seq } = await context.params;
  if (!/^\d+$/.test(seq)) return null;
  const n = Number(seq);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const seq = await seqFrom(context);
    if (seq == null) {
      return NextResponse.json(
        { error: "seq must be a positive integer" },
        { status: 400, headers: NO_STORE },
      );
    }
    const result = await getPeriodBySeq(seq);
    if (result == null) {
      return NextResponse.json(
        { error: "period not found" },
        { status: 404, headers: NO_STORE },
      );
    }
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (err) {
    console.error("GET /api/period/[seq] failed:", err);
    return NextResponse.json(
      { error: "period unavailable" },
      { status: 500, headers: NO_STORE },
    );
  }
}
