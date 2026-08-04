"use client";

// The ledger: every player in the pool, one scrollable table. Filtering
// (docs/DESIGN-WAIVERS.md section 3E) fixes the auction-night gap where it
// existed only on phone: status/position/club now live in one shared filter
// model (components/LedgerFilters.tsx), rendered as a desktop bar above the
// table and a phone sheet - same state, different layout. Sealed valuations
// never appear for unsold rows (the API already withholds them structurally -
// this view just never reads `value` for a row where sold is false).

import type { CSSProperties } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { PlayerRow, PlayersPayload } from "@/lib/players";
import {
  applyLedgerFilters,
  isSortActive,
  LedgerFilterBar,
  LedgerFilterSheet,
  sortArrow,
  useLedgerFilters,
} from "./LedgerFilters";
import { ClubKit, PL_PHOTO, PhoneNav, SILHOUETTE, abbr, money, ownerColor, photoErr, useBoardScale, useIsPhone, usePolledPlayers } from "./tv-common";

/** The read-only spotlight route for a player row (#51). */
function playerHref(id: number): string {
  return `/player/${id}`;
}

function verdictPillClass(v: PlayerRow["verdict"]): string {
  return v === "STEAL" ? "up" : v === "OVERPAY" ? "down" : "flat";
}

function Row({ p }: { p: PlayerRow }) {
  const router = useRouter();
  const href = playerHref(p.id);
  // The whole row navigates for mouse users; the name is a real, focusable
  // link so the row is keyboard-accessible (#51). Modifier/middle clicks fall
  // through to the inner <Link>, which opens a new tab natively.
  const onRowClick = (e: React.MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    router.push(href);
  };
  return (
    <tr className="pd-rowlink" onClick={onRowClick} data-testid={`ledger-row-${p.id}`}>
      <td className={p.ownerShort ? "" : "mut"}>
        {p.ownerShort ? (
          <span className="owncell" style={{ color: ownerColor(p.ownerSlot) }}>
            <span className="owndot" style={{ background: ownerColor(p.ownerSlot) }} />
            {p.ownerSlot != null ? (
              <Link className="pd-namelink" href={`/manager/${p.ownerSlot}`} onClick={(e) => e.stopPropagation()}>
                {abbr(p.ownerShort)}
              </Link>
            ) : (
              abbr(p.ownerShort)
            )}
          </span>
        ) : (
          "-"
        )}
      </td>
      <td className="mut">{p.seq ?? "-"}</td>
      <td>
        <span className="pcell">
          <img
            className="thumb"
            src={p.code != null ? `/assets/players/110/p${p.code}.png` : SILHOUETTE}
            data-cdn={p.code != null ? `${PL_PHOTO}/photos/players/110x140/${p.code}.png` : undefined}
            alt=""
            onError={photoErr}
          />
          <Link className="pd-namelink" href={href} onClick={(e) => e.stopPropagation()}>
            {p.displayName ?? p.name ?? "?"}
          </Link>
        </span>
      </td>
      <td>
        <ClubKit teamCode={p.teamCode} teamShort={p.teamShort} size={22} />
      </td>
      <td>{p.position}</td>
      <td>{p.tier ?? "-"}</td>
      <td>{p.fplPrice != null ? `£${p.fplPrice}` : "-"}</td>
      <td>{p.pts ?? "-"}</td>
      <td>{p.sold ? money(p.price) : "-"}</td>
      <td>
        {!p.sold ? (
          // Unsold players never carry a value in this payload (sealed server-side);
          // "sealed" is just the room-facing label for that absence.
          <span className="sealed">sealed</span>
        ) : p.value != null ? (
          money(p.value)
        ) : (
          // Sold but not yet valued (valuation batch incomplete): "pending",
          // matching the board reveal's wording - never a bare "?".
          <span className="mut">pending</span>
        )}
      </td>
      <td>
        {p.sold && p.verdict ? (
          <span className={`pill ${verdictPillClass(p.verdict)}`}>
            {p.verdict}{p.delta != null ? ` ${money(p.delta)}` : ""}
          </span>
        ) : p.noBid ? (
          <span className="nob">NO BID</span>
        ) : null}
      </td>
    </tr>
  );
}

// ---- Phone layout (plain reflowing HTML, not the scaled TV canvas) --------

function PhoneLedgerRow({ p }: { p: PlayerRow }) {
  const href = playerHref(p.id);
  if (!p.sold) {
    // Unsold: sealed - no value/verdict/delta and no paid price, ever. Lighter
    // treatment (opacity, see .ph-ledger-unsold) plus an explicit "unsold" tag.
    // The whole card is a real link to the read-only spotlight (#51).
    return (
      <Link className="ph-card ph-ledger-row ph-ledger-unsold pd-rowlink" href={href} data-testid={`ph-ledger-${p.id}`}>
        <div className="ph-ledger-left">
          <ClubKit teamCode={p.teamCode} teamShort={p.teamShort} size={20} showLabel={false} />
          <div style={{ minWidth: 0 }}>
            <div className="ph-ledger-name">{p.displayName ?? p.name ?? "?"}</div>
            <div className="ph-sub">
              {p.teamShort ?? "?"} / {p.position} / T{p.tier ?? "?"}
            </div>
          </div>
        </div>
        <div className="ph-ledger-right">
          <span className="ph-sub">unsold</span>
        </div>
      </Link>
    );
  }
  return (
    <Link className="ph-card ph-ledger-row pd-rowlink" href={href} data-testid={`ph-ledger-${p.id}`}>
      <div className="ph-ledger-left">
        <ClubKit teamCode={p.teamCode} teamShort={p.teamShort} size={20} showLabel={false} />
        <div style={{ minWidth: 0 }}>
          <div className="ph-ledger-name">{p.displayName ?? p.name ?? "?"}</div>
          <div className="ph-sub">
            {p.seq != null ? `#${p.seq} · ` : ""}
            {p.teamShort ?? "?"} / {p.position} / T{p.tier ?? "?"}
            {p.ownerShort ? (
              <>
                {" · "}
                <span style={{ color: ownerColor(p.ownerSlot), fontWeight: 700 }}>
                  {abbr(p.ownerShort)}
                </span>
              </>
            ) : null}
          </div>
        </div>
      </div>
      <div className="ph-ledger-right">
        <div className="ph-money-big">{money(p.price)}</div>
        {p.value != null && p.verdict && (
          <span className={`pill ${verdictPillClass(p.verdict)} ph-vpill`}>
            {p.verdict}{p.delta != null ? ` ${money(Math.abs(p.delta))}` : ""}
          </span>
        )}
      </div>
    </Link>
  );
}

function PhoneLedger({ payload, connected }: { payload: PlayersPayload | null; connected: boolean }) {
  const filters = useLedgerFilters();
  const ready = payload !== null;
  const players = payload?.players ?? [];
  const rows = applyLedgerFilters(players, filters.state);

  return (
    <div className="ph-screen" data-testid="ledger-page">
      <div className="ph-header">
        <span className="ph-eyebrow">THE LEDGER</span>
        <span className="ph-headmeta">
          {filters.state.sort.key ? `SORTED BY ${filters.state.sort.key.toUpperCase()}` : ""}
        </span>
      </div>
      <LedgerFilterSheet players={players} filtered={rows} filters={filters} />
      {!ready ? (
        <div className="ph-loading">{connected ? "connecting..." : "connection lost - retrying"}</div>
      ) : (
        <div className="ph-stack">
          {rows.map((p) => (
            <PhoneLedgerRow key={p.id} p={p} />
          ))}
        </div>
      )}
      <PhoneNav />
    </div>
  );
}

// ---- Desktop / TV canvas (the fixed 1600x900 board, filter bar above the table)

function SortableTh({
  label,
  sortKey,
  filters,
}: {
  label: string;
  sortKey: "price" | "value";
  filters: ReturnType<typeof useLedgerFilters>;
}) {
  const active = isSortActive(filters.state, sortKey);
  return (
    <th
      className={`sortable${active ? " sort-active" : ""}`}
      onClick={() => filters.setSort(sortKey)}
      role="button"
      tabIndex={0}
    >
      {label} <span className="arrow">{sortArrow(filters.state, sortKey)}</span>
    </th>
  );
}

export default function LedgerView() {
  const { payload, connected } = usePolledPlayers();
  const { ref, scale } = useBoardScale();
  const isPhone = useIsPhone();
  const filters = useLedgerFilters();
  if (isPhone) return <PhoneLedger payload={payload} connected={connected} />;
  const ready = payload !== null && scale > 0;

  const players = payload?.players ?? [];
  const rows = applyLedgerFilters(players, filters.state);

  return (
    <div data-testid="ledger-page">
      <div
        className={`board-frame${ready ? "" : " loading"}`}
        ref={ref}
        style={{ ["--board-scale" as string]: scale, height: ready ? 900 * scale : undefined } as CSSProperties}
      >
        {!ready ? (
          <div style={{ textAlign: "center" }}>
            <div className="kick" style={{ fontSize: 22 }}>The ledger</div>
            <div style={{ margin: "10px 0" }}>{connected ? "connecting..." : "connection lost - retrying"}</div>
          </div>
        ) : (
          <div className="board-canvas ledger">
            <div className="tv-top">
              <span className="kick">The ledger</span>
              <span className="spacer" />
              <span className="meta">
                {filters.state.sort.key ? `SORTED BY ${filters.state.sort.key.toUpperCase()}` : "DEFAULT ORDER"}
              </span>
            </div>
            <div className="ledcell">
              <LedgerFilterBar players={players} filtered={rows} filters={filters} />
              <table className="led">
                <thead>
                  <tr>
                    <th>Owner</th>
                    <th>#</th>
                    <th>Player</th>
                    <th>Club</th>
                    <th>Pos</th>
                    <th>Tier</th>
                    <th>FPL £</th>
                    <th>&apos;25 pts</th>
                    <SortableTh label="Paid" sortKey="price" filters={filters} />
                    <SortableTh label="Claude" sortKey="value" filters={filters} />
                    <th>&Delta;</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <Row key={p.id} p={p} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
