"use client";

// COMO history (docs/DESIGN-WAIVERS.md screen G): the all-time archive at
// the end of the phase rail. An accordion of seasons, current season open
// at the top linking into the in-app period archives, then prior seasons
// newest first as flat historical records. Sparse data renders as muted
// "not recorded" fields per the mockup rather than blanks or errors.
//
// Data is generated at build time by scripts/build-history-data.mjs from
// docs/history/*.csv into history-data.json (imported statically below, no
// fs at runtime, no API route). Re-run that script after the CSVs change.

import { useEffect, useState } from "react";
import Link from "next/link";
import historyData from "./history-data.json";

// The in-app season CODE (e.g. COMO2526) comes from config via /api/periods,
// never derived from calendar years: the league's code convention does not
// match a simple year mapping (the mockup tags COMO2425 as 2024-25, while the
// ratified spec calls the 2026-27 season COMO2526), so guessing is wrong in
// at least one direction. Past seasons render their plain year label.
function useCurrentSeasonCode(): string | null {
  const [code, setCode] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/periods", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as {
          periods: Array<{ id: number; season: string }>;
          currentPeriodId: number | null;
        };
        const cur = data.periods.find((p) => p.id === data.currentPeriodId) ?? data.periods[0];
        if (!cancelled && cur?.season) setCode(cur.season);
      } catch {
        // Graceful: the card falls back to the plain year label.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return code;
}

type HistoryManagerRollup = {
  manager: string;
  players: number | null;
  spend: number | null;
  squadPoints: number | null;
  bestXiPoints: number | null;
};

type HistoryBuy = {
  player: string;
  manager: string;
  price: number;
  fplPoints?: number;
};

type HistorySeasonEntry = {
  season: string;
  managers: number | null;
  budget: number | null;
  squadSize: number | null;
  recordNote: string | null;
  source: string | null;
  champion: string | null;
  runnerUp: string | null;
  championNote: string | null;
  inProgress: boolean;
  played: boolean;
  perManager: HistoryManagerRollup[];
  topBuy: HistoryBuy | null;
  bestValueBuy: HistoryBuy | null;
  totalSpend: number | null;
  buyCount: number;
};

const CURRENT_SEASON = "2026-27";

function seasonLabel(season: string) {
  // "2026-27" -> "2026 to 2027"
  const [start, endShort] = season.split("-");
  const end = String(Number(start.slice(0, 2) + endShort));
  return `${start} to ${end}`;
}

function money(n: number | null) {
  return n === null ? null : `$${n.toLocaleString()}`;
}

function ChampionLine({ entry }: { entry: HistorySeasonEntry }) {
  if (entry.inProgress) {
    return (
      <div className="hist-champion-line">
        <span className="hist-clabel">Champion</span>
        <span className="hist-cname hist-tbd">In progress</span>
      </div>
    );
  }
  if (!entry.champion) {
    return (
      <div className="hist-champion-line">
        <span className="hist-clabel">Champion</span>
        <span className="hist-cname hist-tbd">
          {entry.championNote ? entry.championNote : "Not recorded"}
        </span>
      </div>
    );
  }
  return (
    <div className="hist-champion-line">
      <span className="hist-clabel">Champion</span>
      <span className="hist-cname">{entry.champion}</span>
    </div>
  );
}

function FinishRow({ entry }: { entry: HistorySeasonEntry }) {
  if (entry.inProgress) return null;
  return (
    <div className="hist-finish-row">
      <div className="hist-fitem">
        <span className="hist-flabel">Runner-up</span>
        <span className={entry.runnerUp ? "hist-fname" : "hist-fname hist-na"}>
          {entry.runnerUp ?? "Not recorded"}
        </span>
      </div>
    </div>
  );
}

function ManagerTable({ entry }: { entry: HistorySeasonEntry }) {
  if (entry.perManager.length === 0) return null;
  return (
    <table className="rb-table hist-table">
      <thead>
        <tr>
          <th>Manager</th>
          <th>Players</th>
          <th>Spend</th>
          <th>Squad points</th>
          <th>Best XI points</th>
        </tr>
      </thead>
      <tbody>
        {entry.perManager.map((m) => (
          <tr key={m.manager}>
            <td>{m.manager}</td>
            <td>{m.players ?? <span className="hist-na">not recorded</span>}</td>
            <td>{money(m.spend) ?? <span className="hist-na">not recorded</span>}</td>
            <td>{m.squadPoints ?? <span className="hist-na">not recorded</span>}</td>
            <td>{m.bestXiPoints ?? <span className="hist-na">not recorded</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StatTiles({ entry }: { entry: HistorySeasonEntry }) {
  return (
    <div className="hist-stat-grid">
      <div className={entry.topBuy ? "hist-stat-tile" : "hist-stat-tile hist-na"}>
        <span className="hist-slabel">Top buy</span>
        {entry.topBuy ? (
          <span className="hist-sval">
            {entry.topBuy.player} <span className="chip">{money(entry.topBuy.price)}</span>{" "}
            <span className="hist-smeta">{entry.topBuy.manager}</span>
          </span>
        ) : (
          <span className="hist-sval">Not recorded</span>
        )}
      </div>
      <div className={entry.bestValueBuy ? "hist-stat-tile" : "hist-stat-tile hist-na"}>
        <span className="hist-slabel">Best value buy</span>
        {entry.bestValueBuy ? (
          <span className="hist-sval">
            {entry.bestValueBuy.player} <span className="chip">{money(entry.bestValueBuy.price)}</span>{" "}
            <span className="hist-smeta">
              {entry.bestValueBuy.fplPoints} pts &middot; {entry.bestValueBuy.manager}
            </span>
          </span>
        ) : (
          <span className="hist-sval">Not recorded</span>
        )}
      </div>
      <div className={entry.totalSpend !== null ? "hist-stat-tile" : "hist-stat-tile hist-na"}>
        <span className="hist-slabel">Total spend</span>
        <span className="hist-sval">{money(entry.totalSpend) ?? "Not recorded"}</span>
      </div>
      <div className={entry.buyCount > 0 ? "hist-stat-tile" : "hist-stat-tile hist-na"}>
        <span className="hist-slabel">Buys recorded</span>
        <span className="hist-sval">{entry.buyCount > 0 ? entry.buyCount : "Not recorded"}</span>
      </div>
    </div>
  );
}

function CurrentSeasonCard({
  entry,
  open,
  onToggle,
  seasonCode,
}: {
  entry: HistorySeasonEntry;
  open: boolean;
  onToggle: () => void;
  seasonCode: string | null;
}) {
  const title = seasonCode ?? entry.season;
  return (
    <section className={open ? "rb-card hist-season-card open" : "rb-card hist-season-card"}>
      <button className="hist-season-toggle" type="button" onClick={onToggle}>
        <span className="hist-season-name">
          {title} <span className="hist-season-tag">{seasonLabel(entry.season)}, current season</span>
        </span>
        <span className="hist-chev">&#8250;</span>
      </button>
      {open && (
        <div className="hist-season-body">
          <ChampionLine entry={entry} />
          <p className="hist-archive-link-line">
            The August auction is archived: <Link href="/phase/1">view the Bid 1 archive</Link>.
          </p>
          <ManagerTable entry={entry} />
          <StatTiles entry={entry} />
          {entry.recordNote && <p className="hist-record-note">{entry.recordNote}</p>}
        </div>
      )}
    </section>
  );
}

function PastSeasonCard({
  entry,
  open,
  onToggle,
}: {
  entry: HistorySeasonEntry;
  open: boolean;
  onToggle: () => void;
}) {
  if (!entry.played) {
    return (
      <section className="rb-card hist-season-card hist-season-card-muted">
        <div className="hist-season-slim">
          <span className="hist-season-name hist-na">
            {seasonLabel(entry.season)}
            <span className="hist-season-tag">{entry.recordNote ?? "No auction run"}</span>
          </span>
        </div>
      </section>
    );
  }
  return (
    <section className={open ? "rb-card hist-season-card open" : "rb-card hist-season-card"}>
      <button className="hist-season-toggle" type="button" onClick={onToggle}>
        <span className="hist-season-name">
          {entry.season} <span className="hist-season-tag">{seasonLabel(entry.season)}</span>
        </span>
        <span className="hist-chev">&#8250;</span>
      </button>
      {open && (
        <div className="hist-season-body">
          <ChampionLine entry={entry} />
          <FinishRow entry={entry} />
          <ManagerTable entry={entry} />
          <StatTiles entry={entry} />
          {entry.recordNote && <p className="hist-record-note">{entry.recordNote}</p>}
          {entry.source && <p className="hist-source-note">Source: {entry.source}</p>}
        </div>
      )}
    </section>
  );
}

export default function HistoryPage() {
  const entries = historyData as HistorySeasonEntry[];
  const current = entries.find((e) => e.season === CURRENT_SEASON) ?? null;
  const past = entries.filter((e) => e.season !== CURRENT_SEASON);
  const seasonCode = useCurrentSeasonCode();

  const [openSeason, setOpenSeason] = useState<string>(CURRENT_SEASON);

  return (
    <div className="rb-desktop">
      <div className="rb-page">
        <header className="rb-header">
          <span className="rb-eyebrow">COMO HISTORY</span>
          <h1 className="rb-title">History</h1>
          <p className="rb-subtitle">Every season of COMO since the beginning. Fold a season open for its record.</p>
        </header>

        <section className="rb-section hist-stack">
          {current && (
            <CurrentSeasonCard
              entry={current}
              seasonCode={seasonCode}
              open={openSeason === current.season}
              onToggle={() => setOpenSeason((s) => (s === current.season ? "" : current.season))}
            />
          )}
          {past.map((entry) => (
            <PastSeasonCard
              key={entry.season}
              entry={entry}
              open={openSeason === entry.season}
              onToggle={() => setOpenSeason((s) => (s === entry.season ? "" : entry.season))}
            />
          ))}
        </section>

        <div className="hist-note">
          <b className="hist-note-tag">Sparse early data</b>
          Records for older seasons are being recovered from spreadsheets and group chats, so some fields are thin
          or missing, especially the further back you go. Any missing field shows a muted &quot;not recorded&quot;
          rather than a blank or an error.
        </div>
      </div>
    </div>
  );
}
