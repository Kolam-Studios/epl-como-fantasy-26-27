"use client";

// Auction Night 2026: the Morning-After Awards. Data lives in
// awards-data.json (copied verbatim from the awards handoff; the blurbs are
// FINAL COPY and render untouched). Awards render natively in the handoff's
// dark navy/gold card theme; the five supporting charts are the pre-rendered
// PNGs under public/awards/. Recipients link to /manager/[slot] by matching
// the award name against the live manager shorts from /api/state; an
// unmatched name renders as plain text so the page never breaks on it.

import { useEffect, useState } from "react";
import Link from "next/link";
import awardsData from "./awards-data.json";

type AwardStats = Record<string, unknown>;

type Award = {
  id: string;
  emoji: string;
  title: string;
  recipients: string[];
  recipientLabel?: string;
  category: "fun" | "analytical";
  tongueInCheek?: boolean;
  blurb: string;
  stats: AwardStats;
  cardImage: string;
};

type AwardsManager = {
  name: string;
  spent: number;
  remaining: number;
  steals: number;
  overpays: number;
  priciestBuy: string;
  priciestPrice: number;
  squadPts: number;
  dollarsPerPoint: number;
};

type AwardsPayload = {
  event: {
    name: string;
    date: string;
    durationMinutes: number;
    lotsCalled: number;
    lotsSold: number;
    lotsPassed: number;
    totalSpent: number;
    valueModelNote: string;
  };
  managers: AwardsManager[];
  awards: Award[];
  assets: {
    coverImage: string;
    charts: Array<{ file: string; title: string; description: string }>;
  };
};

const data = awardsData as unknown as AwardsPayload;

function money(n: number): string {
  return `$${n.toLocaleString("en-AU")}`;
}

/** slot per manager short from the live state payload, for recipient links. */
function useManagerSlots(): Map<string, number> {
  const [slots, setSlots] = useState<Map<string, number>>(new Map());
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/state", { cache: "no-store" });
        if (!res.ok) return;
        const j = (await res.json()) as { managers: Array<{ slot: number; short: string }> };
        if (!cancelled) setSlots(new Map(j.managers.map((m) => [m.short, m.slot])));
      } catch {
        // Names render unlinked; the page still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return slots;
}

function RecipientNames({ award, slots }: { award: Award; slots: Map<string, number> }) {
  if (award.recipientLabel) {
    // A joint award keeps its label verbatim; link each name inside it when
    // the label is exactly the names joined by " vs ".
    const parts = award.recipientLabel.split(" vs ");
    if (parts.every((p) => award.recipients.includes(p))) {
      return (
        <>
          {parts.map((name, i) => (
            <span key={name}>
              {i > 0 && <span className="aw-vs"> vs </span>}
              <RecipientLink name={name} slots={slots} />
            </span>
          ))}
        </>
      );
    }
    return <>{award.recipientLabel}</>;
  }
  return (
    <>
      {award.recipients.map((name, i) => (
        <span key={name}>
          {i > 0 && ", "}
          <RecipientLink name={name} slots={slots} />
        </span>
      ))}
    </>
  );
}

function RecipientLink({ name, slots }: { name: string; slots: Map<string, number> }) {
  const slot = slots.get(name);
  if (slot == null) return <>{name}</>;
  return (
    <Link className="aw-recipient-link" href={`/manager/${slot}`}>
      {name}
    </Link>
  );
}

export default function AwardsPage() {
  const slots = useManagerSlots();
  const { event, managers, awards, assets } = data;

  return (
    <div className="rb-desktop">
      <div className="rb-page">
        <header className="rb-header">
          <span className="rb-eyebrow">AUCTION NIGHT 2026</span>
          <h1 className="rb-title">The Morning-After Awards</h1>
          <p className="rb-subtitle">
            2 August 2026. {event.lotsCalled} lots called over {Math.floor(event.durationMinutes / 60)}h{" "}
            {event.durationMinutes % 60}m, {event.lotsSold} sold, {event.lotsPassed} passed,{" "}
            {money(event.totalSpent)} spent.
          </p>
        </header>

        <section className="rb-section aw-stack">
          {awards.map((a) => (
            <article key={a.id} className="aw-card" id={a.id}>
              <div className="aw-head">
                <span className="aw-emoji" aria-hidden="true">
                  {a.emoji}
                </span>
                <div className="aw-titleblock">
                  <h2 className="aw-title">{a.title}</h2>
                  <div className="aw-recipient">
                    <RecipientNames award={a} slots={slots} />
                  </div>
                </div>
                <div className="aw-badges">
                  <span className={`aw-badge ${a.category}`}>{a.category}</span>
                  {a.tongueInCheek && <span className="aw-badge joke">model humour</span>}
                </div>
              </div>
              <p className="aw-blurb">{a.blurb}</p>
            </article>
          ))}
        </section>

        <section className="rb-section">
          <div className="rb-kick">THE NIGHT IN NUMBERS</div>
          <div className="rb-card rb-prose">
            <div className="aw-tablewrap">
              <table className="rb-table">
                <thead>
                  <tr>
                    <th>Manager</th>
                    <th>Spent</th>
                    <th>Left</th>
                    <th>Steals</th>
                    <th>Overpays</th>
                    <th>Priciest buy</th>
                    <th>&apos;25 pts bought</th>
                    <th>$ / point</th>
                  </tr>
                </thead>
                <tbody>
                  {managers.map((m) => (
                    <tr key={m.name}>
                      <td>
                        <RecipientLink name={m.name} slots={slots} />
                      </td>
                      <td>{money(m.spent)}</td>
                      <td>{money(m.remaining)}</td>
                      <td>{m.steals}</td>
                      <td>{m.overpays}</td>
                      <td>
                        {m.priciestBuy} ({money(m.priciestPrice)})
                      </td>
                      <td>{m.squadPts.toLocaleString("en-AU")}</td>
                      <td>${m.dollarsPerPoint.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section className="rb-section">
          <div className="rb-kick">THE CHARTS</div>
          <div className="aw-charts">
            {assets.charts.map((c) => (
              <figure key={c.file} className="aw-chart">
                {/* Static pre-rendered PNGs from the awards pack; plain img
                    matches how the app serves its other static media. */}
                <img src={`/awards/${c.file}`} alt={c.title} loading="lazy" />
                <figcaption>
                  <b>{c.title}.</b> {c.description}
                </figcaption>
              </figure>
            ))}
          </div>
        </section>

        <div className="rb-footer">{event.valueModelNote}</div>
      </div>
    </div>
  );
}
