"use client";

// One squad-card component, shared by three containers (mockup F,
// docs/DESIGN-WAIVERS.md section 3F): the desktop 2-col grid, the phone
// single column, and the TV's fixed 1600x900 canvas. Always renders the
// manager's FULL squad, grouped GK/DEF/MID/FWD, with config-driven empty-slot
// rows when the squad is short - no top-N cap, no "+N more" row, ever.
//
// The row DATA is passed in as plain props (SquadCardPlayer[]) rather than
// derived here, so the same component can later be fed from a frozen
// period_snapshots payload instead of the live poll (docs/DESIGN-WAIVERS.md
// section 5) without any change to this file.

import Link from "next/link";
import type { Position } from "@/lib/config";
import { ClubKit, money } from "./tv-common";

export const SQUAD_POSITIONS: Position[] = ["GK", "DEF", "MID", "FWD"];
export const POS_LETTER: Record<Position, string> = { GK: "G", DEF: "D", MID: "M", FWD: "F" };

export type SquadCardVariant = "tv" | "phone" | "grid";

export interface SquadCardPlayer {
  id: number;
  position: Position;
  displayName: string;
  teamCode: number | null;
  teamShort: string | null;
  tier: number | null;
  price: number | null;
  verdict: "STEAL" | "OVERPAY" | "FAIR" | null | undefined;
}

export interface SquadCardManager {
  slot: number;
  short: string;
  remaining: number;
  spent: number;
  claudeDelta: number | null;
  squadComplete: boolean;
}

export interface SquadCardProps {
  manager: SquadCardManager;
  /** This manager's currently-owned players, any order - grouped/sorted here. */
  players: SquadCardPlayer[];
  /** Per-position squad quota from the payload (never hardcoded). */
  squad: Record<Position, number>;
  variant: SquadCardVariant;
  testId?: string;
}

function priceColorVar(v: SquadCardPlayer["verdict"]): string {
  if (v === "STEAL") return "var(--vg)";
  if (v === "OVERPAY") return "var(--vb)";
  if (v === "FAIR") return "var(--vf)";
  return "var(--ink)";
}
function deltaPillClass(delta: number | null): string {
  if (delta == null) return "flat";
  if (delta > 0) return "up";
  if (delta < 0) return "down";
  return "flat";
}
function deltaLabel(delta: number | null): string {
  if (delta == null) return "-";
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
  return `${sign}${money(Math.abs(delta))}`;
}

/** One row: a real owned player, or an empty slot (squad short of quota). */
type SlotRow =
  | { kind: "player"; position: Position; player: SquadCardPlayer }
  | { kind: "empty"; position: Position };

/** Group players GK/DEF/MID/FWD (highest price first within a group), then
 * pad each position out to its config quota with empty-slot rows. */
function buildRows(players: SquadCardPlayer[], squad: Record<Position, number>): SlotRow[] {
  const rows: SlotRow[] = [];
  for (const pos of SQUAD_POSITIONS) {
    const inPos = players
      .filter((p) => p.position === pos)
      .sort((a, b) => (b.price ?? 0) - (a.price ?? 0));
    for (const p of inPos) rows.push({ kind: "player", position: pos, player: p });
    const quota = squad[pos] ?? 0;
    for (let i = inPos.length; i < quota; i++) rows.push({ kind: "empty", position: pos });
  }
  return rows;
}

/** Marks the first row of each new position group so the caller can apply a
 * small margin-top between groups (mockup F's "group-start"), with no text
 * label or divider. */
function withGroupStart(rows: SlotRow[]): { row: SlotRow; groupStart: boolean }[] {
  let last: Position | null = null;
  return rows.map((row) => {
    const groupStart = last !== null && row.position !== last;
    last = row.position;
    return { row, groupStart };
  });
}

function TvRow({ row, groupStart }: { row: SlotRow; groupStart: boolean }) {
  if (row.kind === "empty") {
    return (
      <div className={`pr pr-empty${groupStart ? " group-start" : ""}`}>
        <span className={`posmark ${row.position.toLowerCase()}`} title={row.position}>{POS_LETTER[row.position]}</span>
        <span className="mut">empty</span>
        <span />
        <span />
        <span />
      </div>
    );
  }
  const p = row.player;
  return (
    <Link href={`/player/${p.id}`} className={`pr pr-link${groupStart ? " group-start" : ""}`}>
      <span className={`posmark ${p.position.toLowerCase()}`} title={p.position}>{POS_LETTER[p.position]}</span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.displayName}</span>
      <ClubKit teamCode={p.teamCode} teamShort={p.teamShort} size={16} />
      <span className="tn">T{p.tier ?? "?"}</span>
      <span className="p" style={{ color: priceColorVar(p.verdict) }}>{money(p.price)}</span>
    </Link>
  );
}

function PhoneRow({ row }: { row: SlotRow }) {
  if (row.kind === "empty") {
    return (
      <div className="ph-prow ph-prow-empty">
        <span className={`posmark ${row.position.toLowerCase()}`} title={row.position}>{POS_LETTER[row.position]}</span>
        <span className="ph-pname mut">empty slot</span>
      </div>
    );
  }
  const p = row.player;
  return (
    <Link href={`/player/${p.id}`} className="ph-prow ph-prow-link">
      <ClubKit teamCode={p.teamCode} teamShort={p.teamShort} size={18} showLabel={false} />
      <span className="ph-pname">{p.displayName}</span>
      <span className="chip ph-chip">{p.position} T{p.tier ?? "?"}</span>
      <span className="ph-price">{money(p.price)}</span>
    </Link>
  );
}

function GridRow({ row, groupStart }: { row: SlotRow; groupStart: boolean }) {
  if (row.kind === "empty") {
    return (
      <div className={`squad-row${groupStart ? " group-start" : ""}`}>
        <span className={`posmark ${row.position.toLowerCase()}`} title={row.position}>{POS_LETTER[row.position]}</span>
        <span className="sname mut">empty slot</span>
        <span className="sclub">-</span>
        <span className="sprice">-</span>
      </div>
    );
  }
  const p = row.player;
  return (
    <Link href={`/player/${p.id}`} className={`squad-row squad-row-link${groupStart ? " group-start" : ""}`}>
      <span className={`posmark ${p.position.toLowerCase()}`} title={p.position}>{POS_LETTER[p.position]}</span>
      <span className="sname">{p.displayName}</span>
      <span className="sclub">{p.teamShort ?? "?"}</span>
      <span className="sprice">{money(p.price)}</span>
    </Link>
  );
}

export default function SquadCard({ manager, players, squad, variant, testId }: SquadCardProps) {
  const rows = withGroupStart(buildRows(players, squad));
  const empty = players.length === 0;

  if (variant === "tv") {
    return (
      <div className="sq" data-testid={testId}>
        <div className="h">
          <span className="hl">
            <span className="nm">
              <Link href={`/manager/${manager.slot}`}>{manager.short.slice(0, 3).toUpperCase()}</Link>
            </span>
            <span className="big">{money(manager.remaining)}</span>
          </span>
          <span className="hr">
            <span className="spend">{money(manager.spent)}</span>
            {manager.claudeDelta == null ? (
              <span className="nodelta">-</span>
            ) : (
              <span className={`pill ${deltaPillClass(manager.claudeDelta)}`}>{deltaLabel(manager.claudeDelta)}</span>
            )}
          </span>
        </div>
        {empty ? (
          <div className="empty-state">No squad yet.</div>
        ) : (
          rows.map(({ row, groupStart }, i) => (
            <TvRow key={row.kind === "player" ? row.player.id : `empty-${row.position}-${i}`} row={row} groupStart={groupStart} />
          ))
        )}
      </div>
    );
  }

  if (variant === "phone") {
    return (
      <div className="ph-card" data-testid={testId}>
        <div className="ph-sqhead">
          <span className="ph-hl">
            <span className="ph-eyeline">
              <span className="ph-mgr">
                <Link href={`/manager/${manager.slot}`}>{manager.short.slice(0, 3).toUpperCase()}</Link>
              </span>
              <span className="ph-count">{players.length}/{rows.length}</span>
            </span>
            <span className="ph-money-big">{money(manager.remaining)}</span>
          </span>
          <span className="ph-hr">
            <span className="ph-spend">spent {money(manager.spent)}</span>
            {manager.claudeDelta == null ? (
              <span className="ph-nodelta">-</span>
            ) : (
              <span className={`pill ${deltaPillClass(manager.claudeDelta)}`}>{deltaLabel(manager.claudeDelta)}</span>
            )}
          </span>
        </div>
        {empty ? (
          <div className="empty-state">No squad yet.</div>
        ) : (
          <div className="ph-players">
            {rows.map(({ row }, i) => (
              <PhoneRow key={row.kind === "player" ? row.player.id : `empty-${row.position}-${i}`} row={row} />
            ))}
          </div>
        )}
      </div>
    );
  }

  // "grid": the new unscaled desktop container (mockup F), reused later by
  // archived-period summaries per docs/DESIGN-WAIVERS.md section D.
  return (
    <div className="manager-card" data-testid={testId}>
      <div className="mc-head">
        <h2>
          <Link href={`/manager/${manager.slot}`}>{manager.short}</Link>
        </h2>
        <div className="big-num mc-budget">
          {money(manager.remaining)}
          <span className="chip">left</span>
        </div>
      </div>
      <div className="mc-foot">
        <span className="s-spent">{money(manager.spent)} spent</span>
        {manager.claudeDelta == null ? (
          <span className="mut">-</span>
        ) : (
          <span className={`pill ${deltaPillClass(manager.claudeDelta)}`}>{deltaLabel(manager.claudeDelta)} vs Claude</span>
        )}
      </div>
      {empty ? (
        <div className="empty-state">No squad yet.</div>
      ) : (
        <div className="squad-list">
          {rows.map(({ row, groupStart }, i) => (
            <GridRow key={row.kind === "player" ? row.player.id : `empty-${row.position}-${i}`} row={row} groupStart={groupStart} />
          ))}
        </div>
      )}
    </div>
  );
}
