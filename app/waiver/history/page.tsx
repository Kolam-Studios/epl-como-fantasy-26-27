"use client";

// The token history lookup (docs/DESIGN-WAIVERS.md section 3C, mockup C): a
// manager enters their token and sees every waiver form they have saved this
// season, period by period, superseded versions included. The current
// period's saved form (if it is open) leads, with an edit link back into the
// waiver form; every other period folds behind an accordion toggle.
//
// SECURITY: the token lives only in this component's React state and the
// X-Manager-Token request header - never a URL, never localStorage/
// sessionStorage, never logged. POST /api/waiver/history returns the exact
// same {ok:true, found:false} shape for a wrong token as for a manager with
// no submissions, so the UI never distinguishes the two (the mockup's plain
// "No submissions found for that token." message covers both).

import { useState } from "react";
import Link from "next/link";

interface HistoryDrop {
  playerId: number;
  priority: number;
  name: string | null;
  teamShort: string | null;
  position: string | null;
}
interface HistoryBid {
  playerId: number;
  amount: number;
  bidOrder: number;
  name: string | null;
  teamShort: string | null;
  position: string | null;
}
interface HistorySubmission {
  submissionId: number;
  submittedAt: string;
  drops: HistoryDrop[];
  bids: HistoryBid[];
}
interface HistoryPeriod {
  seq: number;
  label: string;
  status: string;
  cutoffAt: string | null;
  submissions: HistorySubmission[];
}
interface HistoryResponse {
  ok: boolean;
  found: boolean;
  manager?: { id: number; slot: number; short: string };
  periods: HistoryPeriod[];
}

function posMark(pos: string | null): string {
  return pos ? pos.toLowerCase() : "";
}

function fmtTs(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** One period's submissions: the effective (latest) form in full, older
 * versions of the SAME period muted under a nested fold. Shared by the
 * featured current-period section and every accordion row. */
function PeriodSubmissions({ period }: { period: HistoryPeriod }) {
  const [showVersions, setShowVersions] = useState(false);
  if (period.submissions.length === 0) {
    return <p className="closed-line">There were no waiver forms saved in this period.</p>;
  }
  const [effective, ...older] = period.submissions;

  return (
    <div>
      <div className="tk-sub-label">Drops, in priority order</div>
      {effective.drops.length === 0 ? (
        <p className="statusline" style={{ margin: "0 0 6px" }}>
          No drops nominated on this form.
        </p>
      ) : (
        <div className="tk-row-list">
          {effective.drops
            .slice()
            .sort((a, b) => a.priority - b.priority)
            .map((d) => (
              <div className="tk-drop-row" key={d.playerId}>
                <span className="tk-rank">{d.priority}</span>
                <span className={`posmark ${posMark(d.position)}`}>{d.position ?? "?"}</span>
                <span className="tk-pname">{d.name ?? "?"}</span>
                <span className="chip">{d.teamShort ?? ""}</span>
              </div>
            ))}
        </div>
      )}

      <div className="tk-sub-label">Blind bids, in form order</div>
      {effective.bids.length === 0 ? (
        <p className="statusline" style={{ margin: "0 0 6px" }}>
          No bids on this form.
        </p>
      ) : (
        <div className="tk-row-list">
          {effective.bids
            .slice()
            .sort((a, b) => a.bidOrder - b.bidOrder)
            .map((b) => (
              <div className="tk-bid-row" key={b.playerId}>
                <span className={`posmark ${posMark(b.position)}`}>{b.position ?? "?"}</span>
                <span className="tk-pname">{b.name ?? "?"}</span>
                <span className="chip">{b.teamShort ?? ""}</span>
                <span className="tk-pamt">${b.amount}</span>
              </div>
            ))}
        </div>
      )}

      <div className="tk-submit-meta">
        <span className="tk-ts">Submitted {fmtTs(effective.submittedAt)}</span>
        {period.status === "open" && (
          <Link href="/waiver">
            <button className="primary" type="button">
              Edit this form
            </button>
          </Link>
        )}
      </div>

      {older.length > 0 && (
        <div className="tk-fold">
          <button
            type="button"
            className={`tk-fold-toggle${showVersions ? " open" : ""}`}
            onClick={() => setShowVersions((v) => !v)}
          >
            <span>
              Previous versions <span className="chip">{older.length} superseded</span>
            </span>
            <span className="tk-chev">&#8250;</span>
          </button>
          {showVersions && (
            <div className="tk-fold-body">
              {older.map((s) => (
                <div className="tk-version-row" key={s.submissionId}>
                  <span className="tk-ts">Submitted {fmtTs(s.submittedAt)}</span>
                  <span className="chip">Superseded</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A past (or non-open) period, collapsed behind the accordion toggle. */
function PastPeriodCard({ period }: { period: HistoryPeriod }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="tk-period-fold">
      <button
        type="button"
        className={`tk-period-fold-toggle${open ? " open" : ""}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span>
          {period.label} <span className="chip">{period.status}</span>
        </span>
        <span className="tk-chev">&#8250;</span>
      </button>
      {open && (
        <section style={{ marginTop: 8 }}>
          <PeriodSubmissions period={period} />
        </section>
      )}
    </div>
  );
}

export default function TokenHistoryPage() {
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<HistoryResponse | null>(null);
  const [networkError, setNetworkError] = useState(false);

  async function lookup(e: React.FormEvent) {
    e.preventDefault();
    if (!token.trim()) return;
    setLoading(true);
    setNetworkError(false);
    try {
      const res = await fetch("/api/waiver/history", {
        method: "POST",
        headers: { "X-Manager-Token": token },
      });
      const json = (await res.json()) as HistoryResponse;
      setResult(json);
    } catch {
      setNetworkError(true);
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  function lookupAnother() {
    setResult(null);
    setToken("");
    setNetworkError(false);
  }

  const showHistory = result != null && result.found;
  const showNotFound = result != null && !result.found;

  const current = showHistory && result.periods[0]?.status === "open" ? result.periods[0] : null;
  const rest = showHistory ? result.periods.filter((p) => p !== current) : [];

  return (
    <div className="screen tk-screen">
      {!showHistory ? (
        <div className="tk-lookup-wrap">
          <section className="tk-lookup-card">
            <div className="rb-kick">MY SUBMISSIONS</div>
            <h1 style={{ margin: "0 0 14px" }}>Look up your saved waiver forms</h1>
            <form onSubmit={lookup}>
              <input
                type="password"
                placeholder="Your token"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              <button className="primary" type="submit" disabled={loading || !token.trim()}>
                {loading ? "Checking..." : "Look up"}
              </button>
            </form>
            <p className="statusline" style={{ textAlign: "left" }}>
              Enter your token to see your saved waiver forms. Your token is the only key: there
              is no account, no email, no password reset. Lost it? Ask the Commissioners.
            </p>
            {networkError && (
              <p className="tk-lookup-msg">Could not reach the server. Try again.</p>
            )}
            {showNotFound && <p className="tk-lookup-msg">No submissions found for that token.</p>}
          </section>
        </div>
      ) : (
        <div>
          <div className="tk-history-head">
            <h1>{result.manager?.short ?? "Manager"}</h1>
          </div>
          <p className="statusline">
            Every waiver form saved this season, newest first.{" "}
            <a href="#" onClick={(e) => { e.preventDefault(); lookupAnother(); }}>
              Look up a different token
            </a>
          </p>

          {current && (
            <section>
              <div className="tk-period-head">
                <h2 style={{ margin: 0 }}>{current.label}, current</h2>
                <span className="state-chip live">Latest form, counts at the cutoff</span>
              </div>
              <p className="tk-period-sub">
                This is the form that will be processed at the cutoff.
              </p>
              <PeriodSubmissions period={current} />
            </section>
          )}

          {rest.map((p) => (
            <PastPeriodCard key={p.seq} period={p} />
          ))}
        </div>
      )}
    </div>
  );
}
