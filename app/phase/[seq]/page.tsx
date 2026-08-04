"use client";

// The phase landing tab ("Budget" in the mockup's sub-rail): the live
// surface for the current period (countdown + waiver form entry point +
// budgets), a stub for a locked/resolving future period, or the archived
// summary for a closed one (docs/DESIGN-WAIVERS.md 2.1/2.2, mockup A).

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { usePeriod } from "@/components/usePeriod";
import PeriodArchive from "@/components/PeriodArchive";
import type { ManagerState, StatePayload } from "@/lib/state";
import { money } from "@/components/tv-common";

const REFRESH_MS = 30000;

/** Fetch /api/state once on mount, refreshed every 30s. The phase landing's
 * budget table does not need the board's ~2s poll cadence, so this is a
 * simple fetch-and-refresh rather than usePolledState's version-gated loop. */
function useManagersSnapshot(): ManagerState[] {
  const [managers, setManagers] = useState<ManagerState[]>([]);
  useEffect(() => {
    let disposed = false;
    async function load() {
      try {
        const res = await fetch("/api/state", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as StatePayload;
        if (!disposed) setManagers(data.managers ?? []);
      } catch {
        // keep the last good snapshot on a blip
      }
    }
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      disposed = true;
      clearInterval(id);
    };
  }, []);
  return managers;
}

interface Countdown {
  days: number;
  hours: number;
  mins: number;
}

/** Client tick to a cutoff instant, or null when there is no cutoff to count
 * down to (either no date yet - "date TBD" - or the period is not open). */
function useCountdown(cutoffAt: string | null): Countdown | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!cutoffAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [cutoffAt]);
  if (!cutoffAt) return null;
  const diff = Math.max(0, new Date(cutoffAt).getTime() - now);
  return {
    days: Math.floor(diff / 86400000),
    hours: Math.floor((diff % 86400000) / 3600000),
    mins: Math.floor((diff % 3600000) / 60000),
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function fmtDate(iso: string | null): string {
  if (!iso) return "date TBD";
  return new Date(iso).toLocaleString("en-AU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "numeric",
    minute: "2-digit",
  });
}

function Shell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rb-desktop">
      <div className="rb-page">
        <header className="rb-header">
          <span className="rb-eyebrow">SEASON PHASE</span>
          <h1 className="rb-title">{label}</h1>
        </header>
        {children}
      </div>
    </div>
  );
}

export default function PhaseBudgetPage() {
  const params = useParams<{ seq: string }>();
  const seq = Number(params.seq);
  const { period, loading } = usePeriod(seq);
  const managers = useManagersSnapshot();
  const countdown = useCountdown(period?.status === "open" ? period.cutoffAt : null);

  if (!Number.isFinite(seq) || seq <= 0) {
    return (
      <Shell label="Unknown phase">
        <div className="rb-card rb-prose">This phase does not exist.</div>
      </Shell>
    );
  }
  if (loading) {
    return (
      <Shell label="Loading">
        <div className="rb-card rb-prose">Loading the phase...</div>
      </Shell>
    );
  }
  if (!period) {
    return (
      <Shell label="Unknown phase">
        <div className="rb-card rb-prose">No period matches phase {seq}.</div>
      </Shell>
    );
  }

  if (period.status === "closed") {
    return (
      <Shell label={period.label}>
        <p className="rb-subtitle">
          <span className="state-chip closed">Archived</span>
        </p>
        <section className="rb-section">
          <div className="rb-kick">PERIOD SUMMARY</div>
          <PeriodArchive seq={seq} sub="budget" />
        </section>
      </Shell>
    );
  }

  if (period.status === "locked") {
    return (
      <Shell label={period.label}>
        <p className="rb-subtitle">
          <span className="state-chip locked">&#128274; Locked</span>
        </p>
        <section className="rb-section">
          <div className="rb-card rb-prose" style={{ textAlign: "center", padding: "56px 20px" }}>
            <div className="rb-title" style={{ fontSize: 34, color: "var(--muted)" }}>
              {period.kind === "rebid" ? "Bid round locked" : "Waiver period locked"}
            </div>
            <p className="rb-subtitle" style={{ margin: "12px 0 0" }}>
              {period.kind === "rebid"
                ? `The live auction runs when this round opens. ${period.cutoffAt ? `Scheduled ${fmtDate(period.cutoffAt)}.` : "Date TBD."}`
                : `Opens ${fmtDate(period.opensAt)}. Submissions due ${fmtDate(period.cutoffAt)}.`}
            </p>
          </div>
        </section>
      </Shell>
    );
  }

  if (period.status === "resolving") {
    return (
      <Shell label={period.label}>
        <p className="rb-subtitle">
          <span className="state-chip locked">Resolving</span>
        </p>
        <section className="rb-section">
          <div className="rb-card rb-prose" style={{ textAlign: "center", padding: "56px 20px" }}>
            <div className="rb-title" style={{ fontSize: 34, color: "var(--muted)" }}>
              Resolution in progress
            </div>
            <p className="rb-subtitle" style={{ margin: "12px 0 0" }}>
              Results publish shortly.
            </p>
          </div>
        </section>
      </Shell>
    );
  }

  // period.status === "open": the live phase.
  return (
    <Shell label={period.label}>
      <p className="rb-subtitle">
        <span className="state-chip live">
          <span className="live-dot" aria-hidden="true" /> Open for submissions
        </span>
      </p>

      <section className="rb-section">
        <div className="rb-kick">SUBMISSIONS CLOSE</div>
        <div className="rb-card rb-prose">
          {countdown ? (
            <div className="count-row">
              <div>
                <span className="cnum">{countdown.days}</span> <span className="clab">days</span>
              </div>
              <div>
                <span className="cnum">{pad2(countdown.hours)}</span> <span className="clab">hours</span>
              </div>
              <div>
                <span className="cnum">{pad2(countdown.mins)}</span> <span className="clab">min</span>
              </div>
            </div>
          ) : (
            <p>Submissions close: date TBD.</p>
          )}
          <p className="rb-subtitle" style={{ margin: "14px 0 0" }}>
            Due {fmtDate(period.cutoffAt)}. You can resubmit as many times as you like; the latest
            form before the cutoff counts.
          </p>
          <Link className="phase-formcta" href="/waiver">
            Open the blind-bid form
          </Link>
        </div>
      </section>

      <section className="rb-section">
        <div className="rb-kick">BUDGETS</div>
        <div className="rb-card rb-prose">
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
                  <td>{money(m.remaining)}</td>
                  <td>
                    {m.squad.length} / {m.squad.length + m.openSlots}
                  </td>
                </tr>
              ))}
              {managers.length === 0 && (
                <tr>
                  <td colSpan={4}>Loading budgets...</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </Shell>
  );
}
