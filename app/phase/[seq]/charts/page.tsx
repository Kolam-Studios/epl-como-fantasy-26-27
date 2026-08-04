"use client";

// Phase charts + analysis sub-tab (docs/DESIGN-WAIVERS.md screen D). Charts
// are a closed-period read (spend by manager/position, price-vs-value,
// awards); this stage ships stubs only - a muted card while the phase is
// still running, the shared frozen-archive note once it closes.

import { useParams } from "next/navigation";
import { usePeriod } from "@/components/usePeriod";
import PeriodArchive from "@/components/PeriodArchive";

function Shell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rb-desktop">
      <div className="rb-page">
        <header className="rb-header">
          <span className="rb-eyebrow">SEASON PHASE</span>
          <h1 className="rb-title">{label} &middot; Charts + Analysis</h1>
        </header>
        {children}
      </div>
    </div>
  );
}

export default function PhaseChartsPage() {
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
          <PeriodArchive seq={seq} sub="charts" />
        </section>
      </Shell>
    );
  }
  return (
    <Shell label={period.label}>
      <section className="rb-section">
        <div className="rb-card rb-prose" style={{ color: "var(--muted)" }}>
          Charts land when the period closes.
        </div>
      </section>
    </Shell>
  );
}
