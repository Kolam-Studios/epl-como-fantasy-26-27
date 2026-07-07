// Commissioner auth for write routes. All writes require
// `Authorization: Bearer <COMMISSIONER_TOKEN>`; reads stay open (war-room
// model, no private data in any read payload).

import { createHash, timingSafeEqual } from "node:crypto";

/**
 * True when the request carries a valid commissioner bearer token.
 *
 * Fails CLOSED: a missing COMMISSIONER_TOKEN env var throws at call time
 * (the route's catch turns that into a 500), so a misconfigured deploy can
 * never accept writes.
 *
 * The comparison is constant-time: both sides are hashed to fixed-length
 * buffers first (timingSafeEqual requires equal lengths, and hashing also
 * avoids leaking the token's length through an early-exit length check).
 */
export function requireCommissioner(request: Request): boolean {
  const expected = process.env.COMMISSIONER_TOKEN;
  if (!expected) {
    throw new Error(
      "COMMISSIONER_TOKEN is not set. Writes are disabled until it is configured (see .env.example).",
    );
  }

  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;

  const presented = createHash("sha256").update(match[1]).digest();
  const wanted = createHash("sha256").update(expected).digest();
  return timingSafeEqual(presented, wanted);
}
