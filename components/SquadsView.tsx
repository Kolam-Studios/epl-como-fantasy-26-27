"use client";

// The room - squads: a 1600x900 TV canvas, 4x2 grid of manager cells. Each
// cell is a quick "how's this manager doing" read: spend, the Claude-value
// verdict on the whole squad, the top-5 spend, and the quota fill. Polls
// /api/players directly (its own poll + scale, independent of the board).

import type { CSSProperties } from "react";
import type { Position } from "@/lib/config";
import type { PlayerRow, PlayersManager } from "@/lib/players";
import { abbr, clubDot, money, useBoardScale, usePolledPlayers } from "./tv-common";

const POSITIONS: Position[] = ["GK", "DEF", "MID", "FWD"];
const POS_LETTER: Record<Position, string> = { GK: "G", DEF: "D", MID: "M", FWD: "F" };
const TOP_N = 5;

/** Verdict -> the CSS var that colours the paid-price figure in the top-5 list. */
function priceColorVar(v: PlayerRow["verdict"]): string {
  if (v === "STEAL") return "var(--vg)";
  if (v === "OVERPAY") return "var(--vb)";
  if (v === "FAIR") return "var(--vf)";
  return "var(--ink)";
}

/** claudeDelta -> pill class (up/down/flat), same convention as the board's verdict pill. */
function deltaPillClass(delta: number | null): string {
  if (delta == null) return "flat";
  if (delta > 0) return "up";
  if (delta < 0) return "down";
  return "flat";
}
function deltaLabel(delta: number | null): string {
  if (delta == null) return "-";
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
  return `${sign}$${Math.abs(delta).toLocaleString()}`;
}

/** "2G 5D 5M 3F" quota-fill string from a manager's owned players. */
function fillsLabel(owned: PlayerRow[]): string {
  const counts: Record<Position, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const p of owned) counts[p.position] += 1;
  return POSITIONS.map((p) => `${counts[p]}${POS_LETTER[p]}`).join(" ");
}

function ManagerCell({ m, byId }: { m: PlayersManager; byId: Map<number, PlayerRow> }) {
  // Owned players, most expensive first - the top-5 the room actually cares about.
  const owned = m.squadPlayerIds
    .map((id) => byId.get(id))
    .filter((p): p is PlayerRow => p != null)
    .sort((a, b) => (b.price ?? 0) - (a.price ?? 0));
  const top = owned.slice(0, TOP_N);
  const more = owned.length - top.length;

  return (
    <div className="sq" data-testid={`squads-manager-${m.slot}`}>
      <div className="h">
        <span className="nm">{abbr(m.short)}</span>
        <span className="fin">{money(m.spent)} - left {money(m.remaining)}</span>
      </div>
      <div className="val">
        <span className="lbl">Claude value</span>
        {m.claudeValue == null ? (
          // Squad players are all sold, so a missing total means values are not
          // in yet (batch incomplete) - "pending", not "sealed" (which implies unsold).
          <span className="v sealed">pending</span>
        ) : (
          <span className="v">{money(m.claudeValue)}</span>
        )}
        <span className={`pill ${deltaPillClass(m.claudeDelta)}`}>{deltaLabel(m.claudeDelta)}</span>
      </div>
      {top.map((p) => (
        <div className="pr" key={p.id}>
          <span className="cdot" style={{ background: clubDot(p.teamShort) }} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name ?? "?"}</span>
          <span className="tn">T{p.tier ?? "?"}</span>
          <span className="p" style={{ color: priceColorVar(p.verdict) }}>{money(p.price)}</span>
        </div>
      ))}
      <div className="more">
        {more > 0 ? `+${more} more - ` : ""}
        {fillsLabel(owned)}
        {m.squadComplete ? " ✓ complete" : ""}
      </div>
    </div>
  );
}

export default function SquadsView() {
  const { payload, connected } = usePolledPlayers();
  const { ref, scale } = useBoardScale();
  const ready = payload !== null && scale > 0;

  const byId = new Map<number, PlayerRow>(payload ? payload.players.map((p) => [p.id, p]) : []);
  const totalManagers = payload?.managers.length ?? 0;
  const completeManagers = payload ? payload.managers.filter((m) => m.squadComplete).length : 0;
  const allDone = totalManagers > 0 && completeManagers === totalManagers;

  return (
    <div data-testid="squads-page">
      <div
        className={`board-frame${ready ? "" : " loading"}`}
        ref={ref}
        style={{ ["--board-scale" as string]: scale, height: ready ? 900 * scale : undefined } as CSSProperties}
      >
        {!ready ? (
          <div style={{ textAlign: "center" }}>
            <div className="kick" style={{ fontSize: 22 }}>The room - squads</div>
            <div style={{ margin: "10px 0" }}>{connected ? "connecting..." : "connection lost - retrying"}</div>
          </div>
        ) : (
          <div className="board-canvas squads">
            <div className="tv-top">
              <span className="kick">The room - squads</span>
              <span className="spacer" />
              <span className="meta">
                {allDone ? "DRAFT COMPLETE" : `${completeManagers}/${totalManagers} complete - live progress`}
              </span>
            </div>
            <div className="sqgrid">
              {payload!.managers.map((m) => (
                <ManagerCell key={m.slot} m={m} byId={byId} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
