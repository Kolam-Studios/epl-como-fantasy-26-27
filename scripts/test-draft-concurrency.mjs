// Concurrency torture test for the sale transaction (repo issue #4): fire
// genuinely simultaneous recordSale calls through one pool (max 12) and
// assert the app_state single-row lock serialises them - exactly one winner,
// clean structured rejections for the rest, no double insert, no oversell.
//
// Usage: node --env-file=.env scripts/test-draft-concurrency.mjs
// (run it several times in a row - it must pass every time)
//
// (a) 10 concurrent sales of the SAME player to 10 DIFFERENT managers:
//     exactly 1 succeeds, 9 rejected cleanly, 1 sale row, version +1.
// (b) 2 concurrent sales of the same player to the SAME manager at a price
//     that individually equals their max bid but together overshoots the
//     budget: exactly 1 lands, the manager's spend stays legal.

import { readFileSync } from "node:fs";
import postgres from "postgres";
import { buildConfig, minOpenBid, squadSize } from "../lib/config-core.mjs";
import { recordSale } from "../lib/draft-core.mjs";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set. Copy .env.example to .env and run with `node --env-file=.env ...`.");
  process.exit(1);
}
// Dedicated pool with headroom for 10 truly simultaneous transactions.
const sql = postgres(url, { max: 12 });

let local;
try {
  local = JSON.parse(readFileSync("league.config.local.json", "utf8"));
} catch {
  local = undefined;
}
const cfg = buildConfig(JSON.parse(readFileSync("league.config.json", "utf8")), local);

// Fixture ids: 9998xx players, manager slots 970..980 (distinct from
// test-draft.mjs's 9999xx / 990..993 so the suites never collide).
const ID_LO = 999800;
const ID_HI = 999899;
const P_RACE = 999810; // scenario (a): 10 managers race for this player
const P_TIGHT = 999811; // scenario (b): same manager, double-spend race
const RACE_SLOTS = [970, 971, 972, 973, 974, 975, 976, 977, 978, 979];
const TIGHT_SLOT = 980;

let failed = false;
function report(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed = true;
}

let savedAppState = null;
let createdAppStateRow = false;

async function cleanup() {
  await sql`
    delete from audit_log
    where action = 'sale.create'
      and (after ->> 'playerId')::int between ${ID_LO} and ${ID_HI}
  `;
  await sql`delete from lot_events where player_id between ${ID_LO} and ${ID_HI}`;
  await sql`delete from sales where player_id between ${ID_LO} and ${ID_HI}`;
  await sql`delete from players where id between ${ID_LO} and ${ID_HI}`;
  await sql`delete from managers where slot between 970 and 980`;
  if (createdAppStateRow) {
    await sql`delete from app_state where id = 1`;
    createdAppStateRow = false;
  } else if (savedAppState) {
    const s = savedAppState;
    await sql`
      update app_state
      set phase = ${s.phase}, paused = ${s.paused},
          current_player_id = ${s.current_player_id}, tv_view = ${s.tv_view},
          reveal_until = ${s.reveal_until},
          nomination_turn = ${s.nomination_turn},
          lot_queue = ${s.lot_queue == null ? null : sql.json(s.lot_queue)},
          pool_frozen = ${s.pool_frozen}, version = ${s.version}
      where id = 1
    `;
    savedAppState = null;
  }
}

async function currentVersion() {
  const [{ version }] = await sql`select version from app_state where id = 1`;
  return Number(version);
}

try {
  await cleanup(); // in case a previous run died mid-way

  const [existingState] = await sql`select * from app_state where id = 1`;
  if (!existingState) {
    await sql`insert into app_state (id) values (1)`;
    createdAppStateRow = true;
  } else {
    savedAppState = existingState;
  }

  const raceManagerIds = [];
  for (const slot of RACE_SLOTS) {
    const [m] = await sql`
      insert into managers (slot, short, display_order)
      values (${slot}, ${"Race M" + slot}, ${slot})
      returning id
    `;
    raceManagerIds.push(m.id);
  }
  const [tightManager] = await sql`
    insert into managers (slot, short, display_order)
    values (${TIGHT_SLOT}, ${"Tight M" + TIGHT_SLOT}, ${TIGHT_SLOT})
    returning id
  `;

  const bottomTier = cfg.tiers[cfg.tiers.length - 1].tier;
  await sql`
    insert into players (id, code, web_name, team_short, position, fpl_price, tier)
    values (${P_RACE}, ${P_RACE}, 'Race Target', 'TST', 'MID', 5.0, ${bottomTier}),
           (${P_TIGHT}, ${P_TIGHT}, 'Tight Target', 'TST', 'FWD', 5.0, ${bottomTier})
  `;

  await sql`
    update app_state
    set phase = 1, paused = false, current_player_id = ${P_RACE},
        tv_view = 'block', lot_queue = ${sql.json([P_RACE, P_TIGHT])}
    where id = 1
  `;

  // --- (a) 10 managers, same player, simultaneous -------------------------

  const reserve = minOpenBid(cfg);
  const versionBeforeA = await currentVersion();
  const settledA = await Promise.allSettled(
    raceManagerIds.map((managerId) =>
      recordSale(sql, cfg, { playerId: P_RACE, managerId, price: reserve, actor: "test-concurrency" }),
    ),
  );

  const thrownA = settledA.filter((s) => s.status === "rejected");
  report(
    "(a) no call threw (all settled to structured results)",
    thrownA.length === 0,
    thrownA.map((s) => String(s.reason)).join("; "),
  );
  const resultsA = settledA.filter((s) => s.status === "fulfilled").map((s) => s.value);
  const winsA = resultsA.filter((r) => r.ok === true);
  const lossesA = resultsA.filter((r) => r.ok === false);
  report("(a) exactly 1 of 10 succeeds", winsA.length === 1, `${winsA.length} wins`);
  report(
    "(a) the other 9 rejected cleanly with a code and message",
    lossesA.length === 9 && lossesA.every((r) => typeof r.code === "string" && typeof r.message === "string"),
    [...new Set(lossesA.map((r) => r.code))].join(", "),
  );
  // Losers must be rejected for exactly the reasons the lock design predicts:
  // a loser that re-reads AFTER the winner committed either sees the lot
  // advanced (wrong_lot) or, if the lot pointer still matches, the winner's
  // sale row (already_sold). Any other code would mean a loser got past both
  // checks and was stopped by a later rule - i.e. the lock is not doing
  // its job.
  report(
    "(a) rejection codes are specifically wrong_lot or already_sold",
    lossesA.every((r) => r.code === "wrong_lot" || r.code === "already_sold"),
    [...new Set(lossesA.map((r) => r.code))].join(", "),
  );
  const [{ n: raceSales }] = await sql`select count(*)::int as n from sales where player_id = ${P_RACE}`;
  report("(a) exactly 1 sale row for the raced player (no double insert)", raceSales === 1, `${raceSales} rows`);
  const versionAfterA = await currentVersion();
  report(
    "(a) version bumped exactly once (one per success)",
    versionAfterA === versionBeforeA + 1,
    `${versionBeforeA} -> ${versionAfterA}`,
  );

  // --- (b) same manager, double-spend race --------------------------------

  // A fresh manager's max bid: remaining - reserve for every OTHER open slot.
  // Two sales at exactly maxBid each individually pass, together overshoot
  // the whole budget - only one may ever land.
  //
  // WHY BOTH RACES TARGET THE SAME PLAYER: a cross-lot double-spend (the same
  // manager winning two DIFFERENT players "simultaneously") is structurally
  // impossible - app_state.current_player_id is a single value, so at most
  // one player can be the current lot, and recordSale rejects any other
  // player with wrong_lot before it even looks at budgets. The only reachable
  // double-spend race is therefore two sales of the SAME lot, which is
  // exactly this scenario's shape; the serialising lock plus the post-lock
  // maxBid re-derivation make the second one lose.
  const maxBid = cfg.budget - reserve * (squadSize(cfg) - 1);
  await sql`update app_state set current_player_id = ${P_TIGHT} where id = 1`;
  const versionBeforeB = await currentVersion();
  const settledB = await Promise.allSettled([
    recordSale(sql, cfg, { playerId: P_TIGHT, managerId: tightManager.id, price: maxBid, actor: "test-concurrency" }),
    recordSale(sql, cfg, { playerId: P_TIGHT, managerId: tightManager.id, price: maxBid, actor: "test-concurrency" }),
  ]);
  const thrownB = settledB.filter((s) => s.status === "rejected");
  report("(b) no call threw", thrownB.length === 0, thrownB.map((s) => String(s.reason)).join("; "));
  const resultsB = settledB.filter((s) => s.status === "fulfilled").map((s) => s.value);
  const winsB = resultsB.filter((r) => r.ok === true);
  report("(b) exactly 1 of 2 lands", winsB.length === 1, `${winsB.length} wins`);
  const [{ spend }] = await sql`
    select coalesce(sum(price), 0)::int as spend from sales where manager_id = ${tightManager.id}
  `;
  report(
    "(b) manager spend stays legal (spend <= budget)",
    spend === maxBid && spend <= cfg.budget,
    `spend $${spend}, budget $${cfg.budget}`,
  );
  const versionAfterB = await currentVersion();
  report(
    "(b) version bumped exactly once",
    versionAfterB === versionBeforeB + 1,
    `${versionBeforeB} -> ${versionAfterB}`,
  );

  // --- global invariants after the storm ----------------------------------

  const [{ n: totalFixtureSales }] = await sql`
    select count(*)::int as n from sales where player_id between ${ID_LO} and ${ID_HI}
  `;
  report("total fixture sales exactly 2 (one per scenario)", totalFixtureSales === 2, `${totalFixtureSales}`);

  const managerChecks = await sql`
    select m.id, m.short,
           coalesce(sum(s.price), 0)::int as spend,
           count(s.id)::int as owned
    from managers m
    left join sales s on s.manager_id = m.id
    where m.slot between 970 and 980
    group by m.id, m.short
  `;
  report(
    "no fixture manager over budget or over squad quota",
    managerChecks.every((m) => m.spend <= cfg.budget && m.owned <= squadSize(cfg)),
    managerChecks.filter((m) => m.spend > cfg.budget || m.owned > squadSize(cfg)).map((m) => m.short).join(", "),
  );
} catch (err) {
  console.error("test-draft-concurrency failed to run:", err);
  failed = true;
} finally {
  try {
    await cleanup();
  } catch (err) {
    console.error("cleanup failed:", err.message);
    failed = true;
  }
  await sql.end();
}

process.exit(failed ? 1 : 0);
