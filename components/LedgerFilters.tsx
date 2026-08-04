"use client";

// One filter model (mockup E, docs/DESIGN-WAIVERS.md section 3E), shared by
// the desktop ledger and the phone ledger - only the rendered layout differs.
// applyLedgerFilters is exported separately (a pure function of state +
// rows) so other screens (the waiver form's free-agent picker, an archived
// period's frozen ledger) can reuse the exact same filtering without
// depending on the hook or any component.

import { useMemo, useState } from "react";
import type { Position } from "@/lib/config";
import type { PlayerRow } from "@/lib/players";
import { foldedIncludes } from "@/lib/text-core.mjs";

export type LedgerStatus = "all" | "sold" | "unsold";
export type LedgerSortKey = "price" | "value" | "points" | "tier" | null;
export type LedgerSortDir = "asc" | "desc";

export interface LedgerFilterState {
  status: LedgerStatus;
  positions: Set<Position>;
  clubs: Set<string>;
  sort: { key: LedgerSortKey; dir: LedgerSortDir };
}

export function defaultLedgerFilterState(): LedgerFilterState {
  return { status: "all", positions: new Set(), clubs: new Set(), sort: { key: null, dir: "desc" } };
}

/** Default order when no sort column is active: sold first (by price desc),
 * then unsold (by last season's points desc) - the existing ledger default. */
function defaultSort(a: PlayerRow, b: PlayerRow): number {
  if (a.sold !== b.sold) return a.sold ? -1 : 1;
  if (a.sold) return (b.price ?? 0) - (a.price ?? 0);
  return (b.pts ?? 0) - (a.pts ?? 0);
}

function sortValue(p: PlayerRow, key: LedgerSortKey): number {
  switch (key) {
    case "price":
      return p.price ?? -Infinity;
    case "value":
      // Unsold rows never carry a value (sealed server-side); treat as lowest
      // so "unsold" never surfaces at the top of a value sort.
      return p.sold && p.value != null ? p.value : -Infinity;
    case "points":
      return p.pts ?? -Infinity;
    case "tier":
      return -(p.tier ?? 99); // lower tier number = "better", so ascending reads first
    default:
      return 0;
  }
}

/**
 * PURE: filter + sort a player list against a filter state. No React, no
 * hooks - safe to call from anywhere (a future frozen-snapshot ledger, the
 * waiver form's free-agent search restricted to unsold players).
 */
export function applyLedgerFilters(players: PlayerRow[], state: LedgerFilterState): PlayerRow[] {
  let rows = players.filter((p) => {
    if (state.status === "sold" && !p.sold) return false;
    if (state.status === "unsold" && p.sold) return false;
    if (state.positions.size && !state.positions.has(p.position)) return false;
    if (state.clubs.size && !(p.teamShort && state.clubs.has(p.teamShort))) return false;
    return true;
  });
  if (state.sort.key) {
    const key = state.sort.key;
    const dir = state.sort.dir === "asc" ? 1 : -1;
    rows = [...rows].sort((a, b) => (sortValue(a, key) - sortValue(b, key)) * dir);
  } else {
    rows = [...rows].sort(defaultSort);
  }
  return rows;
}

export function useLedgerFilters() {
  const [state, setState] = useState<LedgerFilterState>(defaultLedgerFilterState);

  function setStatus(status: LedgerStatus) {
    setState((s) => ({ ...s, status }));
  }
  function togglePosition(pos: Position) {
    setState((s) => {
      const positions = new Set(s.positions);
      if (positions.has(pos)) positions.delete(pos);
      else positions.add(pos);
      return { ...s, positions };
    });
  }
  function toggleClub(club: string) {
    setState((s) => {
      const clubs = new Set(s.clubs);
      if (clubs.has(club)) clubs.delete(club);
      else clubs.add(club);
      return { ...s, clubs };
    });
  }
  function clearClubs() {
    setState((s) => ({ ...s, clubs: new Set() }));
  }
  function setSort(key: Exclude<LedgerSortKey, null>) {
    setState((s) => {
      if (s.sort.key === key) return { ...s, sort: { key, dir: s.sort.dir === "asc" ? "desc" : "asc" } };
      return { ...s, sort: { key, dir: "desc" } };
    });
  }
  function clearAll() {
    setState(defaultLedgerFilterState());
  }

  return { state, setStatus, togglePosition, toggleClub, clearClubs, setSort, clearAll, setState };
}

// ---- Shared filter-bar building blocks (desktop bar + phone sheet) --------

const POSITIONS: Position[] = ["GK", "DEF", "MID", "FWD"];

/** Phone sort chips: the pre-existing "paid/points/value/tier" options
 * (docs/DESIGN-WAIVERS.md section 3E), now writing into the shared sort
 * state instead of local phone-only useState. */
const PHONE_SORT_OPTIONS: { key: Exclude<LedgerSortKey, null>; label: string }[] = [
  { key: "price", label: "Paid" },
  { key: "points", label: "Points" },
  { key: "value", label: "Value" },
  { key: "tier", label: "Tier" },
];

/** Clubs present in the payload, each with a live count against the CURRENT
 * status/position filters (but not the club filter itself, so opening the
 * popover shows real counts for every club, not just already-selected ones). */
function clubCounts(players: PlayerRow[], state: LedgerFilterState): { club: string; count: number }[] {
  const preClub = players.filter((p) => {
    if (state.status === "sold" && !p.sold) return false;
    if (state.status === "unsold" && p.sold) return false;
    if (state.positions.size && !state.positions.has(p.position)) return false;
    return true;
  });
  const counts = new Map<string, number>();
  for (const p of preClub) {
    if (!p.teamShort) continue;
    counts.set(p.teamShort, (counts.get(p.teamShort) ?? 0) + 1);
  }
  return [...counts.entries()].map(([club, count]) => ({ club, count })).sort((a, b) => a.club.localeCompare(b.club));
}

export interface LedgerFilterBarProps {
  players: PlayerRow[];
  filtered: PlayerRow[];
  filters: ReturnType<typeof useLedgerFilters>;
  /** Render as the compact phone sheet layout instead of the desktop bar. */
  phone?: boolean;
}

function ActivePills({ filters }: { filters: ReturnType<typeof useLedgerFilters> }) {
  const { state, setStatus, togglePosition, toggleClub, clearAll } = filters;
  const pills: { label: string; onRemove: () => void }[] = [];
  if (state.status !== "all") pills.push({ label: state.status.toUpperCase(), onRemove: () => setStatus("all") });
  for (const pos of state.positions) pills.push({ label: pos, onRemove: () => togglePosition(pos) });
  for (const club of state.clubs) pills.push({ label: club, onRemove: () => toggleClub(club) });
  if (pills.length === 0) return null;
  return (
    <div className="active-pills">
      {pills.map((p) => (
        <span className="active-pill" key={p.label}>
          {p.label}
          <button type="button" aria-label={`Remove ${p.label} filter`} onClick={p.onRemove}>&times;</button>
        </span>
      ))}
      <button type="button" className="link-btn" onClick={clearAll}>Clear all</button>
    </div>
  );
}

function ClubPopover({
  players,
  state,
  toggleClub,
  clearClubs,
}: {
  players: PlayerRow[];
  state: LedgerFilterState;
  toggleClub: (club: string) => void;
  clearClubs: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const clubs = useMemo(() => clubCounts(players, state), [players, state]);
  const visible = clubs.filter((c) => foldedIncludes(c.club, search));

  return (
    <div className="club-select">
      <button type="button" className="fchip" onClick={() => setOpen((o) => !o)}>
        {state.clubs.size ? `${state.clubs.size} club${state.clubs.size === 1 ? "" : "s"}` : "Any club"}
        <span className="caret">&#9660;</span>
      </button>
      {open && (
        <div className="club-panel open">
          <input
            type="text"
            placeholder="Search clubs"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search clubs"
          />
          <div className="club-list">
            {visible.map((c) => (
              <label key={c.club}>
                <input
                  type="checkbox"
                  checked={state.clubs.has(c.club)}
                  onChange={() => toggleClub(c.club)}
                />
                {c.club} <span className="mut">({c.count})</span>
              </label>
            ))}
          </div>
          <div className="panel-actions">
            <button type="button" className="link-btn" onClick={clearClubs}>Clear</button>
            <button type="button" className="link-btn" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Desktop filter bar: status/position/club filter groups, active pills, and
 * a live result count. Sits above the .led table. */
export function LedgerFilterBar({ players, filtered, filters }: LedgerFilterBarProps) {
  const { state, setStatus, togglePosition, toggleClub, clearClubs } = filters;
  return (
    <div className="ledger-filters">
      <div className="filter-group">
        <span className="filter-label">Status</span>
        {(["all", "sold", "unsold"] as LedgerStatus[]).map((s) => (
          <button
            key={s}
            type="button"
            className={`fchip${state.status === s ? " active" : ""}`}
            onClick={() => setStatus(s)}
          >
            {s === "all" ? "All" : s === "sold" ? "Sold" : "Unsold"}
          </button>
        ))}
      </div>
      <div className="filter-group">
        <span className="filter-label">Position</span>
        {POSITIONS.map((pos) => (
          <button
            key={pos}
            type="button"
            className={`fchip${state.positions.has(pos) ? " active" : ""}`}
            onClick={() => togglePosition(pos)}
          >
            {pos}
          </button>
        ))}
      </div>
      <div className="filter-group">
        <span className="filter-label">Club</span>
        <ClubPopover players={players} state={state} toggleClub={toggleClub} clearClubs={clearClubs} />
      </div>
      <ActivePills filters={filters} />
      <div className="result-count">{filtered.length} of {players.length} players</div>
    </div>
  );
}

/** Sort-indicator helpers for a clickable desktop <th> (mockup E's
 * th.sortable/.arrow convention): whether the column is the active sort and
 * which arrow glyph to show. */
export function isSortActive(state: LedgerFilterState, key: Exclude<LedgerSortKey, null>): boolean {
  return state.sort.key === key;
}
export function sortArrow(state: LedgerFilterState, key: Exclude<LedgerSortKey, null>): string {
  if (state.sort.key !== key) return "▼";
  return state.sort.dir === "asc" ? "▲" : "▼";
}

/** Phone sheet: same state, chip-row layout matching the existing phone
 * ledger conventions (ph-ctrlgroup/ph-chipbtn), plus the club popover as a
 * bottom sheet (CSS handles the fixed-panel treatment under 640px). */
export function LedgerFilterSheet({ players, filtered, filters }: LedgerFilterBarProps) {
  const { state, setStatus, togglePosition, toggleClub, clearClubs, setSort, setState } = filters;
  return (
    <div className="ledger-filters ledger-filters-phone">
      <div className="ph-ctrlwrap">
        <div className="ph-ctrlgroup" role="group" aria-label="Sort ledger by">
          {PHONE_SORT_OPTIONS.map((o) => (
            <button
              key={o.key}
              type="button"
              className={`ph-chipbtn${state.sort.key === o.key ? " active" : ""}`}
              aria-pressed={state.sort.key === o.key}
              onClick={() => setSort(o.key)}
            >
              {o.label}
            </button>
          ))}
        </div>
        <div className="ph-ctrlgroup" role="group" aria-label="Position">
          <button
            type="button"
            className={`ph-chipbtn${state.positions.size === 0 ? " active" : ""}`}
            aria-pressed={state.positions.size === 0}
            onClick={() => setState((s) => ({ ...s, positions: new Set() }))}
          >
            All
          </button>
          {POSITIONS.map((pos) => (
            <button
              key={pos}
              type="button"
              className={`ph-chipbtn${state.positions.has(pos) ? " active" : ""}`}
              aria-pressed={state.positions.has(pos)}
              onClick={() => togglePosition(pos)}
            >
              {pos}
            </button>
          ))}
        </div>
        <div className="ph-ctrlgroup" role="group" aria-label="Status">
          {(["all", "sold", "unsold"] as LedgerStatus[]).map((s) => (
            <button
              key={s}
              type="button"
              className={`ph-chipbtn${state.status === s ? " active" : ""}`}
              aria-pressed={state.status === s}
              onClick={() => setStatus(s)}
            >
              {s === "all" ? "All" : s === "sold" ? "Sold" : "Unsold"}
            </button>
          ))}
        </div>
        <div className="ph-ctrlgroup" role="group" aria-label="Club">
          <ClubPopover players={players} state={state} toggleClub={toggleClub} clearClubs={clearClubs} />
        </div>
      </div>
      <ActivePills filters={filters} />
      <div className="result-count">{filtered.length} of {players.length} players</div>
    </div>
  );
}
