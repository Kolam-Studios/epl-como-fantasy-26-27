"use client";

// Auction Night 2026 analysis block: the awards pack rendered as the Bid 1
// archive's Charts + Analysis pane (and reusable anywhere else). Order per
// the owner: the night in numbers, then the five charts full-width one per
// line, then the twelve square card images (cover + 11 awards) in a 4-wide
// grid. Each award tile links to its full native card on /awards, where the
// blurbs live as text.

import Link from "next/link";
import awardsData from "@/app/awards/awards-data.json";

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

type AwardsLite = {
  managers: AwardsManager[];
  awards: Array<{ id: string; title: string; cardImage: string }>;
  assets: {
    coverImage: string;
    charts: Array<{ file: string; title: string; description: string }>;
  };
};

const data = awardsData as unknown as AwardsLite;

function money(n: number): string {
  return `$${n.toLocaleString("en-AU")}`;
}

export default function AuctionAwardsAnalysis() {
  const { managers, awards, assets } = data;

  return (
    <div>
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
                    <td>{m.name}</td>
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
        <div className="aw-charts-stack">
          {assets.charts.map((c) => (
            <figure key={c.file} className="aw-chart">
              <img src={`/awards/${c.file}`} alt={c.title} loading="lazy" />
              <figcaption>
                <b>{c.title}.</b> {c.description}
              </figcaption>
            </figure>
          ))}
        </div>
      </section>

      <section className="rb-section">
        <div className="rb-kick">THE AWARDS</div>
        <div className="aw-tilegrid">
          <Link className="aw-tile" href="/awards" title="The Morning-After Awards">
            <img src={`/awards/${assets.coverImage}`} alt="The Morning-After Awards" loading="lazy" />
          </Link>
          {awards.map((a) => (
            <Link key={a.id} className="aw-tile" href={`/awards#${a.id}`} title={a.title}>
              <img src={`/awards/${a.cardImage}`} alt={a.title} loading="lazy" />
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
