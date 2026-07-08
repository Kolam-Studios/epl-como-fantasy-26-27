// GET /api/players - the ledger + squads read. Every player in the pool with
// current ownership (through trades), the price paid and the sealed Claude
// value REVEALED ONLY for sold players. Open read, no auth (war-room model: no
// private data leaves here; sealed valuations for unsold players are excluded
// STRUCTURALLY in lib/players-core.mjs). Never cached: the ledger must reflect
// the latest recorded sale/trade.

import { NextResponse } from "next/server";
import { getPlayersPayload } from "@/lib/players";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const payload = await getPlayersPayload();
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    // Log the real error server-side; never leak it to clients.
    console.error("GET /api/players failed:", err);
    return NextResponse.json(
      { error: "players unavailable" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
