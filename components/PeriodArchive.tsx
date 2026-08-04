"use client";

// The frozen record of a CLOSED period (docs/DESIGN-WAIVERS.md 2.2, screen D).
// Stage 2 keeps this deliberately small: a final-budgets table on the
// "budget" sub-tab (from period_snapshots.payload.recap.managers), and a
// generic "frozen archive" note on the other sub-tabs that links back to the
// budget landing. A later stage builds the full archived squads/ledger/
// trades/charts treatment; this component is kept separate so that build-out
// does not have to touch the phase route files.
//
// Reads /api/period/:seq once per seq (snapshots never change after they are
// frozen - see lib/period-core.mjs freezeSnapshot - so there is nothing to
// poll here).

import { useEffect, useState } from "react";
import Link from "next/link";
import { money } from "./tv-common";

type ArchiveSub = "budget" | "squads" | "ledger" | "trades" | "charts";

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
}

interface PeriodBySeqResponse {
  period: PeriodSummary;
  snapshot: { payload: { recap?: { managers?: SnapshotRecapManager[] } }; frozenAt: string } | null;
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
  const snapshot = data?.snapshot ?? null;

  if (!snapshot) {
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
  const managers = snapshot.payload?.recap?.managers ?? [];

  if (sub !== "budget") {
    return (
      <div className="rb-card rb-prose">
        <p>
          {label} is archived; its {sub} record is frozen exactly as it stood at close.
        </p>
        <p>
          <Link href={`/phase/${seq}`}>See the {label} budget summary</Link> for the frozen record now
          - a dedicated archived {sub} view lands in a later stage.
        </p>
      </div>
    );
  }

  return (
    <div className="rb-card rb-prose">
      <p>Final budgets when {label} closed.</p>
      <table className="rb-table">
        <thead>
          <tr>
            <th>Manager</th>
            <th>Spent</th>
            <th>Leftover</th>
          </tr>
        </thead>
        <tbody>
          {managers.map((m) => (
            <tr key={m.slot}>
              <td>{m.short}</td>
              <td>{money(m.spent)}</td>
              <td>{money(m.leftover)}</td>
            </tr>
          ))}
          {managers.length === 0 && (
            <tr>
              <td colSpan={3}>No manager rows in this snapshot.</td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="rb-subtitle" style={{ margin: "10px 0 0" }}>
        Frozen {frozenAt}. Squads, ledger and trades sub-tabs show this same frozen archive.
      </p>
    </div>
  );
}
