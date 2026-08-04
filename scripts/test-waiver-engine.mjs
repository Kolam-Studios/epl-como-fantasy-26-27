// PURE test suite for the waiver engine walk (lib/waiver-engine-core.mjs).
// No DB. The worked example in docs/DESIGN-WAIVERS.md section 4.3 is the
// PERMANENT fixture here: the engine must reproduce that exact outcome -
// every award, every skip reason, every final balance - forever. If this
// suite fails, the engine is wrong, not the spec.
// Usage: node scripts/test-waiver-engine.mjs
import { computeResolution, sortBids } from "../lib/waiver-engine-core.mjs";

let failed = false;
function report(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failed = true;
}

// ---- the spec 4.3 worked example, verbatim ---------------------------------
// Free agents: FW1..FW4, MF1, DF1, GK1. Owned nominated drops: FW-a etc.
const FW1 = 101, FW2 = 102, FW3 = 103, FW4 = 104, MF1 = 201, DF1 = 301, GK1 = 401;
const FWa = 111, FWb = 112, MFa = 211, FWc = 113, MFb = 212, DFa = 311, FWd = 114, GKa = 411;

const A = 1, B = 2, C = 3, D = 4;

function workedExampleForms() {
  return [
    {
      managerId: A, short: "Manager A", startRemaining: 120,
      drops: [
        { playerId: FWa, position: "FWD", priority: 1 },
        { playerId: FWb, position: "FWD", priority: 2 },
        { playerId: MFa, position: "MID", priority: 3 },
      ],
      bids: [
        { playerId: FW1, position: "FWD", amount: 60, bidOrder: 1 },
        { playerId: FW2, position: "FWD", amount: 45, bidOrder: 2 },
        { playerId: FW3, position: "FWD", amount: 30, bidOrder: 3 },
        { playerId: MF1, position: "MID", amount: 25, bidOrder: 4 },
        { playerId: FW4, position: "FWD", amount: 20, bidOrder: 5 },
      ],
    },
    {
      managerId: B, short: "Manager B", startRemaining: 95,
      drops: [{ playerId: FWc, position: "FWD", priority: 1 }],
      bids: [
        { playerId: FW1, position: "FWD", amount: 60, bidOrder: 1 },
        { playerId: MF1, position: "MID", amount: 40, bidOrder: 2 },
      ],
    },
    {
      managerId: C, short: "Manager C", startRemaining: 260,
      drops: [
        { playerId: MFb, position: "MID", priority: 1 },
        { playerId: DFa, position: "DEF", priority: 2 },
      ],
      bids: [
        { playerId: DF1, position: "DEF", amount: 80, bidOrder: 1 },
        { playerId: MF1, position: "MID", amount: 50, bidOrder: 2 },
        { playerId: FW2, position: "FWD", amount: 50, bidOrder: 3 },
      ],
    },
    {
      managerId: D, short: "Manager D", startRemaining: 40,
      drops: [
        { playerId: FWd, position: "FWD", priority: 1 },
        { playerId: GKa, position: "GK", priority: 2 },
      ],
      bids: [
        { playerId: FW1, position: "FWD", amount: 38, bidOrder: 1 },
        { playerId: FW4, position: "FWD", amount: 30, bidOrder: 2 },
        { playerId: GK1, position: "GK", amount: 25, bidOrder: 3 },
        { playerId: FW3, position: "FWD", amount: 12, bidOrder: 4 },
      ],
    },
  ];
}

const SEED = "spec-4-3-fixture";
const { outcomes, managers } = computeResolution({ forms: workedExampleForms(), seed: SEED });

const byMgrPlayer = new Map(outcomes.map((o) => [`${o.managerId}:${o.playerId}`, o]));
const oc = (m, p) => byMgrPlayer.get(`${m}:${p}`);

report("14 bids, 14 outcome rows", outcomes.length === 14, `got ${outcomes.length}`);

// Every award, every skip reason (spec 4.3 table).
report("row: C wins DF1 for $80, drops DF-a",
  oc(C, DF1)?.outcome === "won" && oc(C, DF1)?.price === 80 && oc(C, DF1)?.droppedPlayerId === DFa);
report("row: B wins the FW1 tie (smaller purse)",
  oc(B, FW1)?.outcome === "won" && oc(B, FW1)?.price === 60 && oc(B, FW1)?.droppedPlayerId === FWc);
report("row: A's equal $60 on FW1 is lost_tie", oc(A, FW1)?.outcome === "lost_tie");
report("row: C wins MF1 for $50, drops MF-b",
  oc(C, MF1)?.outcome === "won" && oc(C, MF1)?.droppedPlayerId === MFb);
report("row: C's $50 on FW2 skips for position (no FWD drop)",
  oc(C, FW2)?.outcome === "skipped_position");
report("row: A wins FW2 for $45 AFTER the higher bid skipped, drops FW-a (priority 1)",
  oc(A, FW2)?.outcome === "won" && oc(A, FW2)?.price === 45 && oc(A, FW2)?.droppedPlayerId === FWa);
report("row: B's $40 on MF1 is player_taken", oc(B, MF1)?.outcome === "player_taken");
report("row: D's $38 on FW1 is player_taken", oc(D, FW1)?.outcome === "player_taken");
report("row: A wins FW3 for $30, drops FW-b (priority 2)",
  oc(A, FW3)?.outcome === "won" && oc(A, FW3)?.droppedPlayerId === FWb);
report("row: D wins FW4 for $30, drops FW-d",
  oc(D, FW4)?.outcome === "won" && oc(D, FW4)?.droppedPlayerId === FWd);
report("row: D's $25 on GK1 skips for funds (priced out by its own FW4 win)",
  oc(D, GK1)?.outcome === "skipped_funds");
report("row: A's $25 on MF1 is player_taken", oc(A, MF1)?.outcome === "player_taken");
report("row: A's $20 on FW4 is player_taken", oc(A, FW4)?.outcome === "player_taken");
report("row: D's $12 on FW3 is player_taken", oc(D, FW3)?.outcome === "player_taken");

// Walk-order properties that are seed-independent.
const seqOf = (m, p) => oc(m, p)?.sequence ?? -1;
report("amounts walk high to low",
  outcomes.every((o, i) => i === 0 || outcomes[i - 1].amount >= o.amount));
report("proportional tie-break orders B's $60 before A's $60", seqOf(B, FW1) < seqOf(A, FW1));
report("C's equal $50s follow C's form order (MF1 first)", seqOf(C, MF1) < seqOf(C, FW2));
report("GK1 goes unawarded and stays in the pool",
  outcomes.every((o) => !(o.playerId === GK1 && o.outcome === "won")));

// Final state table from the spec.
const fin = new Map(managers.map((m) => [m.managerId, m]));
report("final: A paid $75, $45 remaining, MF-a retained",
  fin.get(A).paid === 75 && fin.get(A).endRemaining === 45 &&
  fin.get(A).retained.length === 1 && fin.get(A).retained[0] === MFa);
report("final: B paid $60, $35 remaining",
  fin.get(B).paid === 60 && fin.get(B).endRemaining === 35 && fin.get(B).retained.length === 0);
report("final: C paid $130, $130 remaining",
  fin.get(C).paid === 130 && fin.get(C).endRemaining === 130 && fin.get(C).retained.length === 0);
report("final: D paid $30, $10 remaining, GK-a retained",
  fin.get(D).paid === 30 && fin.get(D).endRemaining === 10 &&
  fin.get(D).retained.length === 1 && fin.get(D).retained[0] === GKa);
report("skips spend nothing (total paid = sum of won prices)",
  managers.reduce((s, m) => s + m.paid, 0) ===
  outcomes.filter((o) => o.outcome === "won").reduce((s, o) => s + o.price, 0));

// ---- determinism and seed replay -------------------------------------------
const again = computeResolution({ forms: workedExampleForms(), seed: SEED });
report("same seed, same input => byte-identical outcome log",
  JSON.stringify(again.outcomes) === JSON.stringify(outcomes));
const otherSeed = computeResolution({ forms: workedExampleForms(), seed: "different-seed" });
report("different seed never changes AWARDS in the fixture (only neutral ordering)",
  JSON.stringify(otherSeed.managers) === JSON.stringify(managers));

// ---- targeted edges beyond the fixture -------------------------------------

// skipped_capacity: one FWD slot, two eligible FWD bids on different players.
{
  const r = computeResolution({
    seed: "cap",
    forms: [{
      managerId: 1, short: "M1", startRemaining: 100,
      drops: [{ playerId: 11, position: "FWD", priority: 1 }],
      bids: [
        { playerId: 21, position: "FWD", amount: 30, bidOrder: 1 },
        { playerId: 22, position: "FWD", amount: 20, bidOrder: 2 },
      ],
    }],
  });
  report("edge: second FWD bid skips for capacity after the slot is consumed",
    r.outcomes[0].outcome === "won" && r.outcomes[1].outcome === "skipped_capacity");
}

// preTaken bid (target stopped being a free agent before the round).
{
  const r = computeResolution({
    seed: "pre",
    forms: [{
      managerId: 1, short: "M1", startRemaining: 100,
      drops: [{ playerId: 11, position: "MID", priority: 1 }],
      bids: [{ playerId: 21, position: "MID", amount: 30, bidOrder: 1, preTaken: true }],
    }],
  });
  report("edge: pre-taken target reads player_taken and spends nothing",
    r.outcomes[0].outcome === "player_taken" && r.managers[0].endRemaining === 100);
}

// A drop slot that evaporated (all drops invalid) skips for POSITION.
{
  const r = computeResolution({
    seed: "evap",
    forms: [{
      managerId: 1, short: "M1", startRemaining: 100,
      drops: [], // re-validation removed everything
      bids: [{ playerId: 21, position: "MID", amount: 30, bidOrder: 1 }],
    }],
  });
  report("edge: no valid drops at all => skipped_position", r.outcomes[0].outcome === "skipped_position");
}

// Equal amount, same player, equal PROPORTION: seed decides, deterministically.
{
  const forms = [
    { managerId: 1, short: "M1", startRemaining: 100,
      drops: [{ playerId: 11, position: "MID", priority: 1 }],
      bids: [{ playerId: 99, position: "MID", amount: 50, bidOrder: 1 }] },
    { managerId: 2, short: "M2", startRemaining: 100,
      drops: [{ playerId: 12, position: "MID", priority: 1 }],
      bids: [{ playerId: 99, position: "MID", amount: 50, bidOrder: 1 }] },
  ];
  const r1 = computeResolution({ forms, seed: "tie-seed" });
  const r2 = computeResolution({ forms, seed: "tie-seed" });
  const winner1 = r1.outcomes.find((o) => o.outcome === "won")?.managerId;
  const winner2 = r2.outcomes.find((o) => o.outcome === "won")?.managerId;
  const loser = r1.outcomes.find((o) => o.outcome === "lost_tie");
  report("edge: dead-equal tie resolves by seed, reproducibly",
    winner1 != null && winner1 === winner2 && loser != null);
}

// Zero-purse manager can never be awarded (division guard in the sort).
{
  const r = computeResolution({
    seed: "zero",
    forms: [{
      managerId: 1, short: "M1", startRemaining: 0,
      drops: [{ playerId: 11, position: "MID", priority: 1 }],
      bids: [{ playerId: 21, position: "MID", amount: 5, bidOrder: 1 }],
    }],
  });
  report("edge: zero purse skips for funds", r.outcomes[0].outcome === "skipped_funds");
}

// ADVERSARIAL REGRESSION: the tie-break must be immune to input order.
// Manager 1 (purse $60) bids $50 on P1 and $50 on an unrelated P2; Manager 2
// (purse $200) bids $50 on the SAME P1. Rule 2b: the smaller purse (M1) wins
// P1, full stop. A pairwise comparator was intransitive here (2c's form-order
// edge through P2 could flip the P1 winner depending on which manager's form
// was iterated first). The structural sort must give M1 the win BOTH ways.
{
  const m1 = {
    managerId: 1, short: "M1", startRemaining: 60,
    drops: [
      { playerId: 11, position: "MID", priority: 1 },
      { playerId: 12, position: "MID", priority: 2 },
    ],
    bids: [
      { playerId: 91, position: "MID", amount: 50, bidOrder: 1 }, // P1, contested
      { playerId: 92, position: "FWD", amount: 50, bidOrder: 2 }, // P2, unbacked
    ],
  };
  const m2 = {
    managerId: 2, short: "M2", startRemaining: 200,
    drops: [{ playerId: 13, position: "MID", priority: 1 }],
    bids: [{ playerId: 91, position: "MID", amount: 50, bidOrder: 1 }],
  };
  const winnersFor = (forms) => {
    const r = computeResolution({ forms, seed: "order-independence" });
    return r.outcomes.find((o) => o.playerId === 91 && o.outcome === "won")?.managerId;
  };
  report("regression: smaller purse wins the contested tie (forms M1,M2)",
    winnersFor([m1, m2]) === 1);
  report("regression: smaller purse wins the contested tie (forms M2,M1)",
    winnersFor([m2, m1]) === 1);
}

// Input-order independence in general: shuffling forms/bids never changes
// the outcome log for a fixed seed.
{
  const forms = workedExampleForms();
  const shuffled = [forms[3], forms[1], forms[0], forms[2]].map((f) => ({
    ...f,
    bids: [...f.bids].reverse(),
  }));
  const a = computeResolution({ forms, seed: SEED });
  const b = computeResolution({ forms: shuffled, seed: SEED });
  const key = (r) => JSON.stringify(r.outcomes.map((o) => [o.managerId, o.playerId, o.outcome, o.price]).sort());
  report("regression: outcome set is input-order independent", key(a) === key(b));
}

// sortBids never mutates its input.
{
  const bids = [
    { managerId: 1, playerId: 5, amount: 10, bidOrder: 1, startRemaining: 50 },
    { managerId: 2, playerId: 6, amount: 20, bidOrder: 1, startRemaining: 50 },
  ];
  const copy = JSON.stringify(bids);
  sortBids(bids, "x");
  report("sortBids is non-mutating", JSON.stringify(bids) === copy);
}

process.exit(failed ? 1 : 0);
