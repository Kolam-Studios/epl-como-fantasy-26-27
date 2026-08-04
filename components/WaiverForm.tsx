"use client";

// The waiver blind-bid form (docs/DESIGN-WAIVERS.md section 3B, mockup B). A
// four-step wizard, one card, with a click-to-jump progress rail. Structure
// and behavior are ported from Como/waiver-mockups/B-waiver-form.html, whose
// inline JS is the reference implementation - this component is that same
// state machine wired to the real /api/waiver* endpoints instead of in-file
// fake data.
//
// The manager's waiver token lives ONLY in this component's React state and
// the X-Manager-Token request header. It is never put in a URL, never
// written to localStorage/sessionStorage, and never logged.

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { Position } from "@/lib/config";
import { foldedIncludes } from "@/lib/text-core.mjs";

const POSITION_ORDER: Position[] = ["GK", "DEF", "MID", "FWD"];
const POSITION_NOUN: Record<Position, string> = {
  GK: "goalkeeper",
  DEF: "defender",
  MID: "midfielder",
  FWD: "forward",
};

/* ---------------------------------------------------------------------
   Types for the slice of /api/state and /api/players this form reads, and
   the full shape of /api/waiver/context and /api/waiver. Defined locally
   (rather than importing lib/state.ts's ManagerState) because the state
   payload's satOut flag is not yet part of that exported type and this
   file only ever reads a handful of fields from either payload.
   --------------------------------------------------------------------- */

interface StateManagerLite {
  id: number;
  slot: number;
  short: string;
  satOut?: boolean;
}

interface StatePeriodLite {
  id: number;
  seq: number;
  label: string;
  kind: string;
  cutoffAt: string | null;
  status: string;
}

interface StateLite {
  managers: StateManagerLite[];
  currentPeriod: StatePeriodLite | null;
  /** position quotas from config, e.g. {GK:2, DEF:5, MID:5, FWD:3} */
  squad: Record<Position, number>;
}

interface FreeAgentLite {
  id: number;
  name: string | null;
  displayName: string | null;
  teamShort: string | null;
  position: Position;
  sold: boolean;
}

interface PlayersLite {
  players: FreeAgentLite[];
}

interface SquadPlayer {
  playerId: number;
  name: string;
  displayName: string | null;
  teamShort: string | null;
  position: Position;
  salary: number;
}

interface SavedDrop {
  playerId: number;
  priority: number;
  name: string;
  teamShort: string | null;
  position: Position;
}

interface SavedBid {
  playerId: number;
  amount: number;
  bidOrder: number;
  name: string;
  teamShort: string | null;
  position: Position;
}

interface ContextOk {
  ok: true;
  period: StatePeriodLite;
  manager: { id: number; slot: number; short: string };
  remaining: number;
  squad: SquadPlayer[];
  saved: null | {
    submissionId: number;
    submittedAt: string;
    drops: SavedDrop[];
    bids: SavedBid[];
  };
}

interface ApiRejection {
  ok: false;
  code: string;
  message: string;
}

interface SubmitOk {
  ok: true;
  submissionId: number;
  submittedAt: string;
  period: { label: string };
  warnings: string[];
}

/** One bid row in the on-screen form order. This exact array order is what
 * gets POSTed as `bids` - it is the tie-break rule (docs/DESIGN-WAIVERS.md
 * 4.2.b), so nothing here may ever silently resort it. Review-step display
 * sorts a COPY for presentation only. */
interface BidRow {
  rowId: number;
  playerId: number | null;
  name: string;
  teamShort: string | null;
  position: Position | null;
  query: string;
  amount: string;
}

function posMark(pos: Position | null): string {
  return pos ? pos.toLowerCase() : "";
}

function joinEnglish(parts: string[]): string {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** Counts of nominated drops by position - the win rights a manager holds
 * this round, position by position (docs/DESIGN-WAIVERS.md 4.1). */
function countByPosition(squad: SquadPlayer[], dropIds: number[]): Record<Position, number> {
  const c: Record<Position, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  const byId = new Map(squad.map((p) => [p.playerId, p]));
  for (const id of dropIds) {
    const p = byId.get(id);
    if (p) c[p.position] += 1;
  }
  return c;
}

function buildDropSummary(squad: SquadPlayer[], dropIds: number[]): string {
  const c = countByPosition(squad, dropIds);
  const total = dropIds.length;
  if (total === 0) return "No drops nominated yet. A bid with no matching drop can never win.";
  const abbrParts = POSITION_ORDER.filter((p) => c[p] > 0).map((p) => `${c[p]} ${p}`);
  const winParts = POSITION_ORDER.filter((p) => c[p] > 0).map(
    (p) => `${c[p]} ${c[p] === 1 ? POSITION_NOUN[p] : `${POSITION_NOUN[p]}s`}`,
  );
  return `${total} drop${total === 1 ? "" : "s"} nominated: ${abbrParts.join(", ")}. You can win at most ${joinEnglish(winParts)}.`;
}

function formatCutoff(cutoffAt: string | null): string {
  if (!cutoffAt) return "no cutoff set";
  const d = new Date(cutoffAt);
  if (Number.isNaN(d.getTime())) return "no cutoff set";
  return d.toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Countdown string against a cutoff timestamp, ticking every second. Empty
 * once the cutoff has passed (the period is resolving/closed by then; the
 * server is the source of truth either way, this is display only). */
function useCountdown(cutoffAt: string | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!cutoffAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [cutoffAt]);
  if (!cutoffAt) return "";
  const target = new Date(cutoffAt).getTime();
  if (Number.isNaN(target)) return "";
  let ms = target - now;
  if (ms <= 0) return "cutoff has passed";
  const s = Math.floor(ms / 1000);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (days > 0) return `${days}d ${hours}h ${mins}m to go`;
  if (hours > 0) return `${hours}h ${mins}m ${secs}s to go`;
  return `${mins}m ${secs}s to go`;
}

export default function WaiverForm() {
  // ---- season/manager scaffolding, loaded once ----
  const [stateData, setStateData] = useState<StateLite | null>(null);
  const [stateError, setStateError] = useState(false);
  const [freeAgents, setFreeAgents] = useState<FreeAgentLite[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/state", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        setStateData((await res.json()) as StateLite);
      } catch {
        setStateError(true);
      }
    })();
    (async () => {
      try {
        const res = await fetch("/api/players", { cache: "no-store" });
        if (!res.ok) return;
        const payload = (await res.json()) as PlayersLite;
        setFreeAgents(payload.players.filter((p) => p.sold === false));
      } catch {
        // Typeahead degrades to "no matches" if this fails; not fatal.
      }
    })();
  }, []);

  // ---- wizard state ----
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [maxStep, setMaxStep] = useState<1 | 2 | 3 | 4>(1);

  const [managerId, setManagerId] = useState<string>("");
  const [token, setToken] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [step1Error, setStep1Error] = useState<string | null>(null);

  const [context, setContext] = useState<ContextOk | null>(null);
  const [squad, setSquad] = useState<SquadPlayer[]>([]);
  const [dropIds, setDropIds] = useState<number[]>([]);
  const [bids, setBids] = useState<BidRow[]>([]);
  const nextRowId = useRef(1);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<SubmitOk | null>(null);

  const [activeTypeahead, setActiveTypeahead] = useState<number | null>(null);

  const managers = useMemo(
    () => (stateData?.managers ?? []).filter((m) => !m.satOut),
    [stateData],
  );

  // Header period info: the live context's period once verified, otherwise
  // whatever /api/state currently says is live.
  const headerPeriod = context?.period ?? stateData?.currentPeriod ?? null;
  const countdown = useCountdown(headerPeriod?.cutoffAt ?? null);

  const noLivePeriod = stateData != null && stateData.currentPeriod == null;

  function resetFormBody() {
    setDropIds([]);
    setBids([]);
    nextRowId.current = 1;
  }

  async function verify() {
    setStep1Error(null);
    const mgrId = Number(managerId);
    if (!token.trim() || !Number.isInteger(mgrId)) {
      setStep1Error("Enter your token and select your manager.");
      return;
    }
    setVerifying(true);
    try {
      const res = await fetch("/api/waiver/context", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Manager-Token": token },
        body: JSON.stringify({ managerId: mgrId }),
      });
      const json = (await res.json()) as ContextOk | ApiRejection;
      if (!json.ok) {
        setStep1Error(json.message || "That token does not match that manager.");
        setVerifying(false);
        return;
      }
      setContext(json);
      setSquad(json.squad);
      resetFormBody();
      if (json.saved) {
        setDropIds(
          json.saved.drops
            .slice()
            .sort((a, b) => a.priority - b.priority)
            .map((d) => d.playerId),
        );
        setBids(
          json.saved.bids
            .slice()
            .sort((a, b) => a.bidOrder - b.bidOrder)
            .map((b) => ({
              rowId: nextRowId.current++,
              playerId: b.playerId,
              name: b.name,
              teamShort: b.teamShort,
              position: b.position,
              query: b.name,
              amount: String(b.amount),
            })),
        );
      }
      setVerifying(false);
    } catch {
      setStep1Error("Could not reach the server. Try again.");
      setVerifying(false);
    }
  }

  function goStep(n: 1 | 2 | 3 | 4) {
    setStep(n);
    setMaxStep((m) => (n > m ? n : m));
  }

  function maybeGoStep(n: 1 | 2 | 3 | 4) {
    if (n === 1) {
      goStep(1);
      return;
    }
    if (!context) return;
    if (n <= maxStep) goStep(n);
  }

  // ---- step 2: drops ----
  function toggleDrop(playerId: number) {
    setDropIds((prev) =>
      prev.includes(playerId) ? prev.filter((id) => id !== playerId) : [...prev, playerId],
    );
  }

  function moveDrop(playerId: number, dir: -1 | 1) {
    setDropIds((prev) => {
      const pos = prev.indexOf(playerId);
      const newPos = pos + dir;
      if (pos < 0 || newPos < 0 || newPos >= prev.length) return prev;
      const next = prev.slice();
      const tmp = next[pos];
      next[pos] = next[newPos];
      next[newPos] = tmp;
      return next;
    });
  }

  // Squad size derives from the config quotas in the state payload; a manager
  // mid-era always holds a full squad, but the denominator must never be
  // "however many rows loaded".
  const squadSize = useMemo(
    () => Object.values(stateData?.squad ?? {}).reduce((s, n) => s + n, 0) || squad.length,
    [stateData, squad.length],
  );
  const dropCounts = useMemo(() => countByPosition(squad, dropIds), [squad, dropIds]);
  const dropSummary = useMemo(() => buildDropSummary(squad, dropIds), [squad, dropIds]);

  // ---- step 3: bids ----
  function addBidRow() {
    setBids((prev) => [
      ...prev,
      { rowId: nextRowId.current++, playerId: null, name: "", teamShort: null, position: null, query: "", amount: "" },
    ]);
  }

  function removeBidRow(rowId: number) {
    setBids((prev) => prev.filter((b) => b.rowId !== rowId));
    if (activeTypeahead === rowId) setActiveTypeahead(null);
  }

  function updateBidQuery(rowId: number, query: string) {
    setBids((prev) =>
      prev.map((b) => (b.rowId === rowId ? { ...b, query, name: query, playerId: null, position: null, teamShort: null } : b)),
    );
    setActiveTypeahead(query ? rowId : null);
  }

  function selectBidPlayer(rowId: number, agent: FreeAgentLite) {
    setBids((prev) =>
      prev.map((b) =>
        b.rowId === rowId
          ? {
              ...b,
              playerId: agent.id,
              name: agent.displayName ?? agent.name ?? "",
              query: agent.displayName ?? agent.name ?? "",
              teamShort: agent.teamShort,
              position: agent.position,
            }
          : b,
      ),
    );
    setActiveTypeahead(null);
  }

  function updateBidAmount(rowId: number, amount: string) {
    setBids((prev) => prev.map((b) => (b.rowId === rowId ? { ...b, amount } : b)));
  }

  const remaining = context?.remaining ?? 0;

  function bidAmountError(b: BidRow): string | null {
    if (b.amount === "") return null;
    const amt = Number(b.amount);
    if (Number.isNaN(amt) || amt < 1) return "Minimum bid is $1.";
    if (amt > remaining) return `Bid exceeds your remaining budget of $${remaining}.`;
    return null;
  }

  function bidPositionWarning(b: BidRow): string | null {
    if (!b.position) return null;
    if (dropCounts[b.position] === 0) return `You nominated no ${b.position} drop, this bid can never win.`;
    return null;
  }

  const hasBlockingBidError = bids.some((b) => bidAmountError(b) != null);

  const validBids = useMemo(
    () => bids.filter((b) => b.playerId != null && b.amount !== "" && !Number.isNaN(Number(b.amount)) && bidAmountError(b) == null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bids, remaining],
  );
  const highestBid = validBids.length ? Math.max(...validBids.map((b) => Number(b.amount))) : 0;

  function freeAgentMatches(query: string): FreeAgentLite[] {
    if (!query.trim()) return [];
    const chosenElsewhere = new Set(bids.filter((b) => b.playerId != null).map((b) => b.playerId));
    return freeAgents
      .filter((p) => !chosenElsewhere.has(p.id))
      .filter((p) => foldedIncludes(p.displayName ?? p.name ?? "", query) || foldedIncludes(p.name ?? "", query))
      .slice(0, 8);
  }

  // ---- step 4: review ----
  const reviewDrops = dropIds
    .map((id) => squad.find((p) => p.playerId === id))
    .filter((p): p is SquadPlayer => p != null);

  const reviewBids = validBids.slice().sort((a, b) => Number(b.amount) - Number(a.amount));

  async function submit() {
    if (!context) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch("/api/waiver", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Manager-Token": token },
        body: JSON.stringify({
          managerId: context.manager.id,
          drops: dropIds.map((playerId) => ({ playerId })),
          bids: validBids.map((b) => ({ playerId: b.playerId as number, amount: Number(b.amount) })),
        }),
      });
      const json = (await res.json()) as SubmitOk | ApiRejection;
      if (!json.ok) {
        setSubmitError(json.message || "Submission failed.");
        setSubmitting(false);
        return;
      }
      setSubmitted(json);
      setSubmitting(false);
    } catch {
      setSubmitError("Could not reach the server. Try again.");
      setSubmitting(false);
    }
  }

  function editSubmission() {
    setSubmitted(null);
    goStep(2);
  }

  // ---- render ----
  if (stateError && stateData == null) {
    return (
      <div className="screen wv-screen">
        <p className="statusline">Could not load the season state. Reload the page.</p>
      </div>
    );
  }

  if (stateData == null) {
    return (
      <div className="screen wv-screen">
        <p className="statusline">Loading...</p>
      </div>
    );
  }

  if (noLivePeriod && !context) {
    return (
      <div className="screen wv-screen">
        <h1>Waivers</h1>
        <div className="note wv-note-muted">No waiver period is live right now.</div>
      </div>
    );
  }

  return (
    <div className="screen wv-screen">
      <h1>{headerPeriod?.label ?? "Waivers"}</h1>
      <p className="statusline">
        Blind bid submission form.
        {headerPeriod?.cutoffAt ? ` Due ${formatCutoff(headerPeriod.cutoffAt)}.` : ""}
        {countdown ? ` ${countdown}.` : ""}
      </p>

      <section id="wv-form-card">
        <div className="steps">
          {[1, 2, 3, 4].map((n, i) => (
            <div key={n} style={{ display: "contents" }}>
              {i > 0 && <div className="step-line" />}
              <div
                className={`step-item ${n < step || submitted != null ? "done" : n === step ? "current" : "future"}`}
                onClick={() => maybeGoStep(n as 1 | 2 | 3 | 4)}
              >
                <span className="step-circle">{n < step || submitted != null ? "✓" : n}</span>
                <span className="step-label">
                  {n === 1 && "Who you are"}
                  {n === 2 && "Nominate drops"}
                  {n === 3 && "Blind bids"}
                  {n === 4 && "Review + submit"}
                </span>
              </div>
            </div>
          ))}
        </div>

        {step >= 2 && step <= 4 && context && !submitted && (
          <p className="statusline">
            Manager {context.manager.short}, remaining budget ${remaining}, squad {squad.length} / {squadSize}.
          </p>
        )}

        {submitted ? (
          <div className="submitted-box">
            <div className="tick-circle">&#10003;</div>
            <div className="big-num" style={{ fontSize: 26 }}>
              Manager {context?.manager.short}
            </div>
            <p className="statusline" style={{ margin: "6px 0 0" }}>
              Submitted {new Date(submitted.submittedAt).toLocaleString()}
            </p>
            <p className="statusline" style={{ maxWidth: 420, margin: "10px auto 18px" }}>
              You can resubmit any time before the cutoff. Any number of forms may be submitted;
              the latest one before the cutoff is the one that counts.
            </p>
            {submitted.warnings.length > 0 && (
              <div className="wv-warnings">
                {submitted.warnings.map((w, i) => (
                  <div key={i} className="inline-warn">
                    {w}
                  </div>
                ))}
              </div>
            )}
            <button onClick={editSubmission}>Edit this submission</button>
            <p className="statusline" style={{ margin: "12px 0 0" }}>
              <Link href="/waiver/history">View your submission history</Link>
            </p>
          </div>
        ) : step === 1 ? (
          <div>
            <h2>Step 1 of 4, who you are</h2>
            <p className="statusline" style={{ margin: "0 0 14px" }}>
              Enter your waiver token and pick your manager name. The token is the only credential this form checks.
            </p>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 6 }}>
              <div>
                <label className="wv-label">Waiver token</label>
                <input
                  type="password"
                  value={token}
                  onChange={(e) => {
                    setToken(e.target.value);
                    setStep1Error(null);
                  }}
                  placeholder="waiver token"
                  style={{ width: 200 }}
                  autoComplete="off"
                />
              </div>
              <div>
                <label className="wv-label">Manager</label>
                <select
                  value={managerId}
                  onChange={(e) => {
                    setManagerId(e.target.value);
                    setStep1Error(null);
                  }}
                  style={{ width: 180 }}
                >
                  <option value="">Select manager...</option>
                  {managers.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.short}
                    </option>
                  ))}
                </select>
              </div>
              <button className="primary" onClick={verify} disabled={verifying}>
                {verifying ? "Checking..." : "Continue"}
              </button>
            </div>
            {step1Error && <p className="statusline inline-error">{step1Error}</p>}
            {context && (
              <div style={{ marginTop: 14 }}>
                {context.saved && (
                  <div className="note banner-resub">
                    <b className="tag">Form already on file</b>
                    Submitted {new Date(context.saved.submittedAt).toLocaleString()}. It has been loaded below; edit and
                    resubmit to replace it.
                  </div>
                )}
                <p className="statusline" style={{ margin: "0 0 14px" }}>
                  <b style={{ color: "var(--ink)" }}>Manager {context.manager.short} confirmed.</b> Remaining budget $
                  {remaining}. Squad {squad.length} / {squadSize}.
                </p>
                <button className="primary" onClick={() => goStep(2)}>
                  Continue to drops
                </button>
              </div>
            )}
          </div>
        ) : step === 2 ? (
          <div>
            <h2>Step 2 of 4, nominate drops</h2>
            <p className="statusline" style={{ margin: "0 0 8px" }}>
              Mark up to as many players DROP as you like. Each drop only leaves your squad if one of your bids in
              that position wins.
            </p>
            <div>
              {POSITION_ORDER.map((pos) => {
                const rows = squad.filter((p) => p.position === pos);
                if (!rows.length) return null;
                return (
                  <div key={pos}>
                    <div className="squad-group-title">
                      {pos}, {rows.length}
                    </div>
                    {rows.map((p) => {
                      const dropped = dropIds.includes(p.playerId);
                      const priority = dropped ? dropIds.indexOf(p.playerId) + 1 : null;
                      return (
                        <div className="squad-row" key={p.playerId}>
                          <span className={`posmark ${posMark(p.position)}`}>{p.position}</span>
                          <span className="sq-name">{p.displayName ?? p.name}</span>
                          <span className="chip">{p.teamShort ?? ""}</span>
                          <span className="big-num sq-salary">${p.salary}</span>
                          <button
                            className={`kd-toggle ${dropped ? "drop" : "keep"}`}
                            onClick={() => toggleDrop(p.playerId)}
                          >
                            {dropped ? "DROP" : "KEEP"}
                          </button>
                          <span className="drop-ctrls">
                            {dropped && (
                              <>
                                <span className="drop-num">{priority}</span>
                                <button
                                  className="arrow-btn"
                                  onClick={() => moveDrop(p.playerId, -1)}
                                  disabled={priority === 1}
                                >
                                  &#8593;
                                </button>
                                <button
                                  className="arrow-btn"
                                  onClick={() => moveDrop(p.playerId, 1)}
                                  disabled={priority === dropIds.length}
                                >
                                  &#8595;
                                </button>
                              </>
                            )}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
            <p className="drop-summary">{dropSummary}</p>
            <div style={{ marginTop: 16 }}>
              <button onClick={() => goStep(1)}>Back</button>
              <button className="primary" onClick={() => goStep(3)}>
                Continue to bids
              </button>
            </div>
          </div>
        ) : step === 3 ? (
          <div>
            <h2>Step 3 of 4, blind bids</h2>
            <p className="statusline" style={{ margin: "0 0 6px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", fontSize: 11 }}>
              Your win rights this round
            </p>
            <div className="win-rights-row">
              {POSITION_ORDER.map((pos) =>
                dropCounts[pos] > 0 ? (
                  <span key={pos} className="chip win-chip active">
                    {pos} x{dropCounts[pos]}
                  </span>
                ) : (
                  <span key={pos} className="chip win-chip zero">
                    {pos} none
                  </span>
                ),
              )}
            </div>
            <p className="statusline" style={{ margin: "0 0 4px" }}>
              <span className="sealed">Sealed:</span> nobody, including the commissioners, sees anyone's bids or drops
              until the round resolves.
            </p>
            <p className="statusline" style={{ margin: "0 0 14px" }}>
              Each bid is capped at your full remaining budget. You are not reserving budget for other slots, since a
              waiver bid can only ever replace a drop in the same position.
            </p>
            <div>
              {bids.length === 0 ? (
                <p className="statusline" style={{ margin: "0 0 10px" }}>
                  No bids yet. Add a bid for any free agent you want to win.
                </p>
              ) : (
                bids.map((b) => {
                  const amountErr = bidAmountError(b);
                  const posWarn = bidPositionWarning(b);
                  const matches = activeTypeahead === b.rowId ? freeAgentMatches(b.query) : [];
                  return (
                    <div className="bid-row-wrap" key={b.rowId}>
                      <div className="bid-row">
                        <div style={{ position: "relative" }}>
                          <input
                            type="text"
                            placeholder="Search free agents..."
                            value={b.query}
                            autoComplete="off"
                            style={b.position ? { paddingRight: 64 } : undefined}
                            onChange={(e) => updateBidQuery(b.rowId, e.target.value)}
                            onFocus={() => setActiveTypeahead(b.rowId)}
                            onBlur={() => setTimeout(() => setActiveTypeahead((cur) => (cur === b.rowId ? null : cur)), 150)}
                          />
                          {b.position && (
                            <span className="bid-role-badge">
                              <span className={`posmark ${posMark(b.position)}`}>{b.position}</span>
                              <span className="chip">{b.teamShort ?? ""}</span>
                            </span>
                          )}
                          {matches.length > 0 && (
                            <div className="typeahead-list">
                              {matches.map((p) => (
                                <div
                                  key={p.id}
                                  className="typeahead-item"
                                  onMouseDown={(e) => e.preventDefault()}
                                  onClick={() => selectBidPlayer(b.rowId, p)}
                                >
                                  <span>
                                    <span className={`posmark ${posMark(p.position)}`}>{p.position}</span>
                                    {p.displayName ?? p.name}
                                  </span>
                                  <span className="chip">{p.teamShort ?? ""}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                        <input
                          type="number"
                          min={1}
                          placeholder="$ amount"
                          value={b.amount}
                          onChange={(e) => updateBidAmount(b.rowId, e.target.value)}
                        />
                        <button className="remove-bid" onClick={() => removeBidRow(b.rowId)} title="Remove bid">
                          &times;
                        </button>
                      </div>
                      <div className="bid-msg">
                        {amountErr && <div className="inline-error">{amountErr}</div>}
                        {posWarn && <div className="inline-warn">{posWarn}</div>}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
            <button onClick={addBidRow}>+ Add bid</button>
            <div className="bid-strip">
              <div>
                <span className="slab">Bids entered</span>
                <span className="big-num snum">{validBids.length}</span>
              </div>
              <div>
                <span className="slab">Highest bid</span>
                <span className="big-num snum">${highestBid}</span>
              </div>
              <div>
                <span className="slab">Remaining budget</span>
                <span className="big-num snum">${remaining}</span>
              </div>
              <div style={{ flex: "1 1 220px", alignSelf: "center", color: "var(--muted)", fontSize: 12.5 }}>
                You only pay for bids you win. Bids that lose cost nothing.
              </div>
            </div>
            {hasBlockingBidError && (
              <p className="statusline inline-error" style={{ margin: "10px 0 0" }}>
                Fix the bid above your remaining budget before continuing.
              </p>
            )}
            <div style={{ marginTop: 16 }}>
              <button onClick={() => goStep(2)}>Back</button>
              <button className="primary" disabled={hasBlockingBidError} onClick={() => goStep(4)}>
                Continue to review
              </button>
            </div>
          </div>
        ) : (
          <div>
            <h2>Step 4 of 4, review and submit</h2>
            <p className="statusline" style={{ margin: "0 0 4px" }}>
              Drops, in priority order
            </p>
            <div style={{ marginBottom: 18 }}>
              {reviewDrops.length === 0 ? (
                <p className="statusline" style={{ margin: 0 }}>
                  No drops nominated.
                </p>
              ) : (
                reviewDrops.map((p, i) => (
                  <div className="squad-row" key={p.playerId}>
                    <span className="drop-num">{i + 1}</span>
                    <span className={`posmark ${posMark(p.position)}`}>{p.position}</span>
                    <span className="sq-name">{p.displayName ?? p.name}</span>
                    <span className="chip">{p.teamShort ?? ""}</span>
                    <span className="big-num sq-salary">${p.salary}</span>
                  </div>
                ))
              )}
            </div>
            <p className="statusline" style={{ margin: "0 0 4px" }}>
              Bids, highest to lowest
            </p>
            <div style={{ marginBottom: 18 }}>
              {reviewBids.length === 0 ? (
                <p className="statusline" style={{ margin: 0 }}>
                  No bids entered.
                </p>
              ) : (
                reviewBids.map((b) => {
                  const matched = b.position != null && dropCounts[b.position] > 0;
                  return (
                    <div className="squad-row" key={b.rowId}>
                      <span className={`posmark ${posMark(b.position)}`}>{b.position ?? "?"}</span>
                      <span className="sq-name">{b.name || "Unnamed"}</span>
                      <span className="chip">{b.teamShort ?? ""}</span>
                      <span className="big-num sq-salary">${b.amount}</span>
                      {b.position ? (
                        matched ? (
                          <span className="pill up">Matches {b.position} drop</span>
                        ) : (
                          <span className="pill flat">No {b.position} drop nominated</span>
                        )
                      ) : (
                        <span className="pill flat">No player selected</span>
                      )}
                    </div>
                  );
                })
              )}
            </div>
            {submitError && <p className="statusline inline-error">{submitError}</p>}
            <div>
              <button onClick={() => goStep(3)}>Back</button>
              <button className="primary" onClick={submit} disabled={submitting}>
                {submitting ? "Submitting..." : "Submit waiver form"}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
