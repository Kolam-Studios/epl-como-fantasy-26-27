"use client";

// The frozen record of a CLOSED period (docs/DESIGN-WAIVERS.md 2.2, screen D).
// Stage 6 builds the full sub-tab treatment: a "budget" landing that leads
// with the transfer record for a resolved waiver period (mockup D), the
// squads pane through the shared SquadCard, a frozen ledger reusing the
// live filter system, a frozen trades list and a charts + analysis pane.
//
// Reads /api/period/:seq once per seq (snapshots never change after they are
// frozen - see lib/period-core.mjs freezeSnapshot - so there is nothing to
// poll here).

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import AuctionAwardsAnalysis from "./AuctionAwards";
import type { Position } from "@/lib/config";
import type { PlayerRow } from "@/lib/players";
import type { RecapAward } from "@/lib/recap";
import type { TradeRow } from "@/lib/trades";
import SquadCard, { type SquadCardManager, type SquadCardPlayer } from "./SquadCard";
import {
  applyLedgerFilters,
  isSortActive,
  LedgerFilterBar,
  sortArrow,
  useLedgerFilters,
} from "./LedgerFilters";
import { abbr, ClubKit, money, useIsPhone } from "./tv-common";

type ArchiveSub = "budget" | "squads" | "ledger" | "trades" | "charts";

const SQUAD_POSITIONS: Position[] = ["GK", "DEF", "MID", "FWD"];

interface PeriodSummary {
  id: number;
  seq: number;
  label: string;
  kind: string;
  season: string;
}

interface SnapshotRecapManager {
  slot: number;
  short: string;
  spent: number;
  leftover: number;
  squadCount: number;
}

interface SnapshotRecapSquadPlayer {
  id: number;
  webName: string | null;
  displayName: string | null;
  teamShort: string | null;
  position: string | null;
  tier: number | null;
  price: number | null;
  value: number | null;
  verdict: string | null;
}

interface SnapshotRecapSquad {
  slot: number;
  short: string;
  squadCount: number;
  players: SnapshotRecapSquadPlayer[];
}

interface SnapshotRecap {
  managers?: SnapshotRecapManager[];
  squads?: SnapshotRecapSquad[];
  squad?: Record<string, number>;
  totalSpent?: number;
  totalLeftover?: number;
  awards?: {
    biggestOverpay: RecapAward | null;
    steal: RecapAward | null;
    fastestHammer: RecapAward | null;
  };
}

interface SnapshotPlayers {
  players?: PlayerRow[];
}

interface SnapshotTrades {
  trades?: TradeRow[];
  count?: number;
}

interface WaiverOutcomeRow {
  sequence: number;
  managerId: number;
  playerId: number;
  position: string;
  amount: number;
  outcome:
    | "won"
    | "player_taken"
    | "skipped_funds"
    | "skipped_position"
    | "skipped_capacity"
    | "lost_tie";
  price: number | null;
  droppedPlayerId: number | null;
  budgetAfter: number;
}

interface WaiverOutcomeManager {
  managerId: number;
  short: string;
  startRemaining: number;
  paid: number;
  endRemaining: number;
  wins: { playerId: number; price: number; droppedPlayerId: number | null }[];
  released: number[];
  retained: number[];
}

interface SnapshotWaiver {
  seed: string;
  outcomes: WaiverOutcomeRow[];
  managers: WaiverOutcomeManager[];
}

interface SnapshotPayload {
  schemaVersion?: number;
  period?: PeriodSummary;
  recap?: SnapshotRecap;
  players?: SnapshotPlayers;
  trades?: SnapshotTrades;
  waiver?: SnapshotWaiver;
}

interface PeriodBySeqResponse {
  period: PeriodSummary;
  snapshot: { payload: SnapshotPayload; frozenAt: string } | null;
}

function playerLabel(players: PlayerRow[], id: number | null): string {
  if (id == null) return "?";
  const p = players.find((row) => row.id === id);
  return p?.displayName ?? p?.name ?? `player #${id}`;
}

function playerRow(players: PlayerRow[], id: number | null): PlayerRow | null {
  if (id == null) return null;
  return players.find((row) => row.id === id) ?? null;
}

// ---- Budget pane: transfer record (waiver) + final budgets --------------

function TransferRecord({ waiver, players }: { waiver: SnapshotWaiver; players: PlayerRow[] }) {
  const wins = waiver.outcomes.filter((o) => o.outcome === "won");
  const shortFor = (managerId: number) =>
    waiver.managers.find((m) => m.managerId === managerId)?.short ?? `manager ${managerId}`;

  return (
    <section className="rb-section">
      <div className="rb-kick">TRANSFER RECORD</div>
      <div className="rb-card rb-prose">
        {wins.length === 0 ? (
          <p>No waivers were won this period; every nominated drop stays on the squad.</p>
        ) : (
          <table className="rb-table">
            <thead>
              <tr>
                <th>Player won</th>
                <th>Pos</th>
                <th>Winner</th>
                <th>Price</th>
                <th>Dropped</th>
              </tr>
            </thead>
            <tbody>
              {wins.map((o) => {
                const dropped = playerRow(players, o.droppedPlayerId);
                return (
                  <tr key={`${o.sequence}-${o.playerId}`}>
                    <td>{playerLabel(players, o.playerId)}</td>
                    <td>
                      <span className={`posmark ${o.position.toLowerCase()}`}>{o.position}</span>
                    </td>
                    <td>{shortFor(o.managerId)}</td>
                    <td>{money(o.price)}</td>
                    <td>{dropped ? dropped.displayName ?? dropped.name : "-"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="rb-subtitle" style={{ margin: "12px 0 0" }}>
          Resolved with seed <code>{waiver.seed}</code>.
        </p>
      </div>
    </section>
  );
}

function FinalBudgets({ managers, label }: { managers: SnapshotRecapManager[]; label: string }) {
  return (
    <section className="rb-section">
      <div className="rb-kick">FINAL BUDGETS</div>
      <div className="rb-card rb-prose">
        <p>Budgets when {label} closed.</p>
        <table className="rb-table">
          <thead>
            <tr>
              <th>Manager</th>
              <th>Spent</th>
              <th>Remaining</th>
              <th>Squad</th>
            </tr>
          </thead>
          <tbody>
            {managers.map((m) => (
              <tr key={m.slot}>
                <td>{m.short}</td>
                <td>{money(m.spent)}</td>
                <td>{money(m.leftover)}</td>
                <td>{m.squadCount} / 15</td>
              </tr>
            ))}
            {managers.length === 0 && (
              <tr>
                <td colSpan={4}>No manager rows in this snapshot.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function BudgetPane({
  period,
  snapshot,
  frozenAt,
}: {
  period: PeriodSummary;
  snapshot: NonNullable<PeriodBySeqResponse["snapshot"]>;
  frozenAt: string;
}) {
  const managers = snapshot.payload.recap?.managers ?? [];
  const players = snapshot.payload.players?.players ?? [];
  const waiver = snapshot.payload.waiver ?? null;

  return (
    <div>
      {waiver ? (
        <>
          <TransferRecord waiver={waiver} players={players} />
          <FinalBudgets managers={managers} label={period.label} />
        </>
      ) : (
        <FinalBudgets managers={managers} label={period.label} />
      )}
      {period.seq === 1 && (
        <section className="rb-section">
          <div className="rb-card rb-prose">
            <p style={{ margin: 0 }}>
              &#127942; The night has its honours: <Link href="/awards">the Auction Night 2026 awards</Link>.
            </p>
          </div>
        </section>
      )}
      <p className="rb-subtitle">Frozen {frozenAt}. Nothing on this page recomputes.</p>
    </div>
  );
}

// ---- Squads pane: snapshot squads through the shared SquadCard -----------

function SquadsPane({ recap }: { recap: SnapshotRecap }) {
  const isPhone = useIsPhone();
  const squads = recap.squads ?? [];
  const managerBySlot = new Map((recap.managers ?? []).map((m) => [m.slot, m]));
  const quota = (recap.squad ?? {}) as Record<Position, number>;

  if (squads.length === 0) {
    return (
      <section className="rb-section">
        <div className="rb-card rb-prose">No squads recorded in this snapshot.</div>
      </section>
    );
  }

  return (
    <section className="rb-section">
      <div className={isPhone ? "" : "squad-grid"}>
        {squads.map((s) => {
          const m = managerBySlot.get(s.slot);
          const spent = m?.spent ?? 0;
          const remaining = m?.leftover ?? 0;
          const valuedPlayers = s.players.filter((p) => p.value != null);
          const claudeValue =
            valuedPlayers.length === s.players.length && s.players.length > 0
              ? valuedPlayers.reduce((sum, p) => sum + (p.value ?? 0), 0)
              : null;
          const manager: SquadCardManager = {
            slot: s.slot,
            short: s.short,
            remaining,
            spent,
            claudeDelta: claudeValue != null ? claudeValue - spent : null,
            squadComplete: s.squadCount >= 15,
          };
          const players: SquadCardPlayer[] = s.players
            .filter((p) => p.position != null)
            .map((p) => ({
              id: p.id,
              position: p.position as Position,
              displayName: p.displayName ?? p.webName ?? "?",
              teamCode: null,
              teamShort: p.teamShort,
              tier: p.tier,
              price: p.price,
              verdict: (p.verdict as SquadCardPlayer["verdict"]) ?? null,
            }));
          return (
            <SquadCard
              key={s.slot}
              manager={manager}
              players={players}
              squad={quota}
              variant={isPhone ? "phone" : "grid"}
              testId={`archive-squad-${s.slot}`}
            />
          );
        })}
      </div>
    </section>
  );
}

// ---- Ledger pane: frozen players, full filter system ---------------------

function FrozenLedgerRow({ p }: { p: PlayerRow }) {
  return (
    <tr data-testid={`archive-ledger-row-${p.id}`}>
      <td className={p.ownerShort ? "" : "mut"}>
        {p.ownerShort ? (
          <span className="owncell">
            {p.ownerSlot != null ? (
              <Link className="pd-namelink" href={`/manager/${p.ownerSlot}`}>
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
      <td>
        <span className="pcell">
          <Link className="pd-namelink" href={`/player/${p.id}`}>
            {p.displayName ?? p.name ?? "?"}
          </Link>
        </span>
      </td>
      <td>
        <ClubKit teamCode={p.teamCode} teamShort={p.teamShort} size={20} />
      </td>
      <td>{p.position}</td>
      <td>{p.tier ?? "-"}</td>
      <td>{p.sold ? money(p.price) : "-"}</td>
      <td>
        {!p.sold ? (
          <span className="sealed">sealed</span>
        ) : p.value != null ? (
          money(p.value)
        ) : (
          <span className="mut">pending</span>
        )}
      </td>
      <td>
        {p.sold && p.verdict ? (
          <span className={`pill ${p.verdict === "STEAL" ? "up" : p.verdict === "OVERPAY" ? "down" : "flat"}`}>
            {p.verdict}
            {p.delta != null ? ` ${money(p.delta)}` : ""}
          </span>
        ) : p.noBid ? (
          <span className="no-bid">No bid</span>
        ) : null}
      </td>
    </tr>
  );
}

function LedgerPane({ players }: { players: PlayerRow[] }) {
  const filters = useLedgerFilters();
  const rows = useMemo(() => applyLedgerFilters(players, filters.state), [players, filters.state]);

  return (
    <section className="rb-section">
      <div className="rb-card rb-prose">
        <LedgerFilterBar players={players} filtered={rows} filters={filters} />
        <table className="rb-table led">
          <thead>
            <tr>
              <th>Owner</th>
              <th>Player</th>
              <th>Club</th>
              <th>Pos</th>
              <th>Tier</th>
              <th
                className={`sortable${isSortActive(filters.state, "price") ? " sort-active" : ""}`}
                onClick={() => filters.setSort("price")}
              >
                Price <span className="arrow">{sortArrow(filters.state, "price")}</span>
              </th>
              <th
                className={`sortable${isSortActive(filters.state, "value") ? " sort-active" : ""}`}
                onClick={() => filters.setSort("value")}
              >
                Claude value <span className="arrow">{sortArrow(filters.state, "value")}</span>
              </th>
              <th>Verdict</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <FrozenLedgerRow key={p.id} p={p} />
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8}>No players match these filters.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---- Trades pane: frozen trade list, TradesView's card grammar -----------

function FrozenTradeCard({ trade }: { trade: TradeRow }) {
  const when = new Date(trade.createdAt).toLocaleString();
  return (
    <div className="tr-card" data-testid={`archive-trade-${trade.id}`}>
      <div className="tr-card-head">
        <div className="tr-matchup">
          <Link className="pd-namelink" href={`/manager/${trade.managerA.slot}`}>
            {abbr(trade.managerA.short)}
          </Link>
          <span className="tr-vs" aria-hidden>&harr;</span>
          <Link className="pd-namelink" href={`/manager/${trade.managerB.slot}`}>
            {abbr(trade.managerB.short)}
          </Link>
        </div>
        <div className="tr-card-meta">
          <span className="tr-time">{when}</span>
        </div>
      </div>
      <div className="tr-sides">
        <div className="tr-side">
          <div className="tr-side-lbl">{abbr(trade.managerA.short)} gives</div>
          {trade.playersAToB.length === 0 && trade.cashAToB <= 0 ? (
            <div className="tr-side-empty">nothing</div>
          ) : (
            <ul className="tr-plist">
              {trade.playersAToB.map((p) => (
                <li className="tr-prow" key={p.id}>
                  {p.name ?? p.webName ?? "?"} <span className="tr-pos">{p.position ?? "?"}</span>
                </li>
              ))}
              {trade.cashAToB > 0 && <li className="tr-prow tr-cash">{money(trade.cashAToB)}</li>}
            </ul>
          )}
        </div>
        <div className="tr-side">
          <div className="tr-side-lbl">{abbr(trade.managerB.short)} gives</div>
          {trade.playersBToA.length === 0 && trade.cashBToA <= 0 ? (
            <div className="tr-side-empty">nothing</div>
          ) : (
            <ul className="tr-plist">
              {trade.playersBToA.map((p) => (
                <li className="tr-prow" key={p.id}>
                  {p.name ?? p.webName ?? "?"} <span className="tr-pos">{p.position ?? "?"}</span>
                </li>
              ))}
              {trade.cashBToA > 0 && <li className="tr-prow tr-cash">{money(trade.cashBToA)}</li>}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function TradesPane({ trades }: { trades: TradeRow[] }) {
  return (
    <section className="rb-section">
      <div className="rb-card rb-prose">
        <p>
          {trades.length} trade{trades.length === 1 ? "" : "s"} recorded in this period.
        </p>
      </div>
      {trades.length === 0 ? (
        <div className="rb-card rb-prose">No trades in this period.</div>
      ) : (
        <div className="tr-list">
          {trades.map((t) => (
            <FrozenTradeCard key={t.id} trade={t} />
          ))}
        </div>
      )}
    </section>
  );
}

// ---- Charts pane: spend bars, price-vs-value tiles, awards ---------------

function BarRow({ label, value, max, muted }: { label: string; value: number; max: number; muted?: boolean }) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 1000) / 10) : 2;
  return (
    <div className={`bar-row${muted ? " sat-out" : ""}`}>
      <div className="bar-label">{label}</div>
      <div className="bar-track">
        <div className="bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="bar-val" style={muted ? { color: "var(--muted)" } : undefined}>
        {muted ? "sat out" : money(value)}
      </div>
    </div>
  );
}

function AwardCard({ eyebrow, award }: { eyebrow: string; award: RecapAward | null }) {
  if (!award) {
    return (
      <div className="award-card">
        <div className="aw-eyebrow">{eyebrow}</div>
        <div className="aw-title mut">Not recorded</div>
      </div>
    );
  }
  return (
    <div className="award-card">
      <div className="aw-eyebrow">{eyebrow}</div>
      <div className="aw-title">{award.ownerShort ?? "?"}</div>
      <div className="aw-sub">
        {award.name ?? "player"}, paid {money(award.price)}
        {award.value != null ? ` against a ${money(award.value)} value` : ""}
      </div>
    </div>
  );
}

function StatTile({ eyebrow, award, colorVar }: { eyebrow: string; award: RecapAward | null; colorVar: string }) {
  if (!award || award.delta == null) {
    return (
      <div className="stat-tile">
        <div className="big-num stat-num mut">-</div>
        <div className="stat-lab">{eyebrow}</div>
        <div className="stat-sub">Not recorded</div>
      </div>
    );
  }
  const sign = award.delta > 0 ? "+" : award.delta < 0 ? "-" : "";
  return (
    <div className="stat-tile">
      <div className="big-num stat-num" style={{ color: colorVar }}>
        {sign}
        {money(Math.abs(award.delta))}
      </div>
      <div className="stat-lab">{eyebrow}</div>
      <div className="stat-sub">
        {award.name ?? "player"}, {award.ownerShort ?? "?"} paid {money(award.price)} against a{" "}
        {money(award.value)} value
      </div>
    </div>
  );
}

function ChartsPane({ recap, players }: { recap: SnapshotRecap; players: PlayerRow[] }) {
  const managers = recap.managers ?? [];
  const maxSpend = Math.max(1, ...managers.map((m) => m.spent));
  const sortedManagers = [...managers].sort((a, b) => b.spent - a.spent);

  const positionSpend: Record<string, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const p of players) {
    if (p.sold && p.price != null) positionSpend[p.position] = (positionSpend[p.position] ?? 0) + p.price;
  }
  const maxPosSpend = Math.max(1, ...Object.values(positionSpend));

  const awards = recap.awards;

  return (
    <div>
      <section className="chart-block rb-section">
        <div className="rb-kick">SPEND BY MANAGER</div>
        <div className="rb-card">
          {sortedManagers.map((m) => (
            <BarRow key={m.slot} label={m.short} value={m.spent} max={maxSpend} muted={m.spent === 0 && m.squadCount === 0} />
          ))}
          {sortedManagers.length === 0 && <p className="rb-prose">No manager rows in this snapshot.</p>}
        </div>
      </section>

      <section className="chart-block rb-section">
        <div className="rb-kick">SPEND BY POSITION</div>
        <div className="rb-card">
          {SQUAD_POSITIONS.map((pos) => (
            <BarRow key={pos} label={pos} value={positionSpend[pos] ?? 0} max={maxPosSpend} />
          ))}
        </div>
      </section>

      <section className="chart-block rb-section">
        <div className="rb-kick">PRICE VS CLAUDE VALUE</div>
        <div className="stat-grid">
          <StatTile eyebrow="Biggest overpay" award={awards?.biggestOverpay ?? null} colorVar="var(--vb)" />
          <StatTile eyebrow="Biggest bargain" award={awards?.steal ?? null} colorVar="var(--vg)" />
        </div>
      </section>

      <section className="chart-block rb-section">
        <div className="rb-kick">AWARDS, COMPUTED ONCE AT CLOSE</div>
        <div className="award-grid">
          <AwardCard eyebrow="Biggest overpay" award={awards?.biggestOverpay ?? null} />
          <AwardCard eyebrow="Steal of the period" award={awards?.steal ?? null} />
          <AwardCard eyebrow="Fastest hammer" award={awards?.fastestHammer ?? null} />
        </div>
        <p className="rb-subtitle" style={{ margin: "12px 0 0" }}>
          Awards are calculated once, at the moment the period closed; a later trade or waiver
          never changes them.
        </p>
      </section>
    </div>
  );
}

export default function PeriodArchive({ seq, sub = "budget" }: { seq: number; sub?: ArchiveSub }) {
  const [data, setData] = useState<PeriodBySeqResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    fetch(`/api/period/${seq}`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((d: PeriodBySeqResponse | null) => {
        if (!disposed) setData(d);
      })
      .catch(() => {
        if (!disposed) setData(null);
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [seq]);

  if (loading) {
    return <div className="rb-card rb-prose">Loading the archived record...</div>;
  }

  const label = data?.period?.label ?? `phase ${seq}`;
  const period = data?.period ?? null;
  const snapshot = data?.snapshot ?? null;

  if (!snapshot || !period) {
    return (
      <div className="rb-card rb-prose">
        <p>{label} is closed, but no frozen record has been archived for it yet.</p>
      </div>
    );
  }

  const frozenAt = new Date(snapshot.frozenAt).toLocaleString("en-AU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  if (sub === "budget") {
    return <BudgetPane period={period} snapshot={snapshot} frozenAt={frozenAt} />;
  }
  if (sub === "squads") {
    return <SquadsPane recap={snapshot.payload.recap ?? {}} />;
  }
  if (sub === "ledger") {
    return <LedgerPane players={snapshot.payload.players?.players ?? []} />;
  }
  if (sub === "trades") {
    return <TradesPane trades={snapshot.payload.trades?.trades ?? []} />;
  }
  // Bid 1's Charts + Analysis is the Auction Night awards pack (owner call):
  // the night in numbers, the five charts, then the award card tiles. Waiver
  // periods keep the generic computed pane.
  if (period.seq === 1) return <AuctionAwardsAnalysis />;
  return <ChartsPane recap={snapshot.payload.recap ?? {}} players={snapshot.payload.players?.players ?? []} />;
}
