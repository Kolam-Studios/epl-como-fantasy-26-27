"use client";

// Phase trades sub-tab (docs/DESIGN-WAIVERS.md 2.3). Trades stay open all
// season, so the current phase's Trades tab is the live trade log
// (TradesView UNCHANGED, unfiltered - it already shows every non-voided
// trade); an archived phase shows the frozen note. Locked/resolving phases
// have no trade log of their own yet.

import { useParams } from "next/navigation";
import { usePeriod } from "@/components/usePeriod";
import PeriodArchive from "@/components/PeriodArchive";
import TradesView from "@/components/TradesView";

function Shell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rb-desktop">
      <div className="rb-page">
        <header className="rb-header">
          <span className="rb-eyebrow">SEASON PHASE</span>
          <h1 className="rb-title">{label} &middot; Trades</h1>
        </header>
        {children}
      </div>
    </div>
  );
}

export default function PhaseTradesPage() {
  const params = useParams<{ seq: string }>();
  const seq = Number(params.seq);
  const { period, loading } = usePeriod(seq);

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
        <section className="rb-section">
          <PeriodArchive seq={seq} sub="trades" />
        </section>
      </Shell>
    );
  }
  if (period.status !== "open") {
    return (
      <Shell label={period.label}>
        <section className="rb-section">
          <div className="rb-card rb-prose">
            Trades resume once this period is live. Its Budget tab has the current status.
          </div>
        </section>
      </Shell>
    );
  }
  return <TradesView />;
}
