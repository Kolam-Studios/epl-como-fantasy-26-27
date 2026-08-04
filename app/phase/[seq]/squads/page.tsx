"use client";

// Phase squads sub-tab (docs/DESIGN-WAIVERS.md 2.1). While the phase is open,
// this renders the existing SquadsView UNCHANGED (squads are always the live
// squads regardless of which period is current); locked/resolving show a
// stub, closed shows the frozen archive note.

import { useParams } from "next/navigation";
import { usePeriod } from "@/components/usePeriod";
import PeriodArchive from "@/components/PeriodArchive";
import SquadsView from "@/components/SquadsView";

function Shell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rb-desktop">
      <div className="rb-page">
        <header className="rb-header">
          <span className="rb-eyebrow">SEASON PHASE</span>
          <h1 className="rb-title">{label} &middot; Squads</h1>
        </header>
        {children}
      </div>
    </div>
  );
}

export default function PhaseSquadsPage() {
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
          <PeriodArchive seq={seq} sub="squads" />
        </section>
      </Shell>
    );
  }
  if (period.status !== "open") {
    return (
      <Shell label={period.label}>
        <section className="rb-section">
          <div className="rb-card rb-prose">
            Squads open once this period is live. Its Budget tab has the current status.
          </div>
        </section>
      </Shell>
    );
  }
  return <SquadsView />;
}
