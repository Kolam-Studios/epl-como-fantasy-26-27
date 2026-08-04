// POST /api/waiver/history - the token history lookup (mockup C): a manager
// enters their token and sees their own submissions, period by period,
// superseded versions included. The response is IDENTICAL in shape for a
// wrong token and a manager with no submissions ("found": false) - lookups
// never confirm whether a token exists.

import { NextResponse } from "next/server";
import { tokenHistory } from "@/lib/waiver";

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
    const result = await tokenHistory(token);
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (err) {
    console.error("POST /api/waiver/history failed:", err);
    return NextResponse.json({ error: "history lookup failed" }, { status: 500, headers: NO_STORE });
  }
}
