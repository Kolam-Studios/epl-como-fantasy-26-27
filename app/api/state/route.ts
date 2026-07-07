// GET /api/state - the one payload every surface polls (~2s). Open read, no
// auth (war-room model: no private data; sealed valuations are excluded
// structurally in lib/state-core.mjs). Never cached: the whole point is that
// every poll sees the latest recorded sale.

import { NextResponse } from "next/server";
import { getStatePayload } from "@/lib/state";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const payload = await getStatePayload();
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    // Log the real error server-side; never leak it to clients.
    console.error("GET /api/state failed:", err);
    return NextResponse.json(
      { error: "state unavailable" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
