"use client";

// COMO history (docs/DESIGN-WAIVERS.md screen G): the all-time archive at the
// end of the phase rail. Stage 2 ships a graceful stub only, so the History
// tab never 404s; the full accordion of past seasons is a later stage.

export default function HistoryPage() {
  return (
    <div className="rb-desktop">
      <div className="rb-page">
        <header className="rb-header">
          <span className="rb-eyebrow">COMO HISTORY</span>
          <h1 className="rb-title">History</h1>
        </header>
        <section className="rb-section">
          <div className="rb-card rb-prose" style={{ color: "var(--muted)" }}>
            The COMO archive is being recovered; season records land here.
          </div>
        </section>
      </div>
    </div>
  );
}
