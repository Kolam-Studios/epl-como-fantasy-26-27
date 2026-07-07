// POST /api/lot - the console's lot-engine actions (02-SPEC §E): no_bid,
// pause, resume, set_tv, end_phase_one, nominate, build_queue.
// Commissioner-gated; all rules are enforced server-side inside serialising
// transactions (lib/lot-core.mjs). Client greying is UX, not defence.

import { NextResponse } from "next/server";
import { requireCommissioner } from "@/lib/auth";
import {
  buildQueue,
  endPhaseOne,
  noBid,
  nominate,
  pause,
  resume,
  setTv,
  type LotResult,
} from "@/lib/lot";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400, headers: NO_STORE });
}

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
      return bad("body must be JSON: {action, ...params}");
    }
    const { action, view, playerId, managerSlot } = (body ?? {}) as Record<string, unknown>;
    const actor = "commissioner";

    let result: LotResult<Record<string, unknown>>;
    switch (action) {
      case "build_queue":
        result = await buildQueue({ actor });
        break;
      case "no_bid":
        result = await noBid({ actor });
        break;
      case "pause":
        result = await pause({ actor });
        break;
      case "resume":
        result = await resume({ actor });
        break;
      case "set_tv":
        if (typeof view !== "string") {
          return bad("set_tv requires a view: {action: 'set_tv', view: 'block'|'reveal'|'squads'|'ledger'|'paused'}");
        }
        result = await setTv({ view, actor });
        break;
      case "end_phase_one":
        result = await endPhaseOne({ actor });
        break;
      case "nominate":
        if (!Number.isInteger(playerId) || !Number.isInteger(managerSlot)) {
          return bad("nominate requires whole-number playerId and managerSlot");
        }
        result = await nominate({
          playerId: playerId as number,
          managerSlot: managerSlot as number,
          actor,
        });
        break;
      case "next":
        // The handoff API list names a 'next' action, but advancing is
        // derived, never a bare skip: a recorded sale advances the lot
        // (POST /api/draft) and a pass-over is a no_bid (which both logs the
        // lot_events row and advances). A silent 'next' would drop a lot from
        // the record, so it is rejected on purpose.
        return bad("'next' is not an action: a lot advances via a recorded sale or the no_bid action");
      default:
        return bad(
          "unknown action - expected one of build_queue, no_bid, pause, resume, set_tv, end_phase_one, nominate",
        );
    }

    if (!result.ok) {
      // A rule rejection, not an error: the console shows result.message.
      return NextResponse.json(result, { status: 422, headers: NO_STORE });
    }
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (err) {
    // Log the real error server-side; never leak it to clients.
    console.error("POST /api/lot failed:", err);
    return NextResponse.json({ error: "lot action failed" }, { status: 500, headers: NO_STORE });
  }
}
