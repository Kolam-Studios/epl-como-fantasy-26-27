// POST /api/draft - THE critical endpoint (repo issue #4): record a sale.
// Commissioner-gated; all legality rules are enforced server-side inside a
// serialising transaction (lib/draft-core.mjs). Client greying is UX, not
// defence.

import { NextResponse } from "next/server";
import { requireCommissioner } from "@/lib/auth";
import { recordSale } from "@/lib/draft";

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

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "body must be JSON: {playerId, managerId, price}" },
        { status: 400, headers: NO_STORE },
      );
    }
    const { playerId, managerId, price } = (body ?? {}) as Record<string, unknown>;
    if (
      !Number.isInteger(playerId) ||
      !Number.isInteger(managerId) ||
      !Number.isInteger(price)
    ) {
      return NextResponse.json(
        { error: "playerId, managerId and price must all be whole numbers" },
        { status: 400, headers: NO_STORE },
      );
    }

    const result = await recordSale({
      playerId: playerId as number,
      managerId: managerId as number,
      price: price as number,
      actor: "commissioner",
    });

    if (!result.ok) {
      // A rule rejection, not an error: the console shows result.message.
      return NextResponse.json(result, { status: 422, headers: NO_STORE });
    }
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (err) {
    // Log the real error server-side; never leak it to clients.
    console.error("POST /api/draft failed:", err);
    return NextResponse.json(
      { error: "sale failed" },
      { status: 500, headers: NO_STORE },
    );
  }
}
