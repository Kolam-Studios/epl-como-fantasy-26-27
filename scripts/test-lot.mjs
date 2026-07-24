// Integration test for the lot engine (lib/lot-core.mjs) against a live DB -
// no dev server needed, it drives the exact same transactions the
// POST /api/lot route serves.
//
// Usage: node --env-file=.env scripts/test-lot.mjs
//
// Seeds fixture players (997xxx ids) and fixture managers (slots 970-973),
// captures the FULL app_state row before touching it and restores it in
// finally; deletes all fixtures (pre-cleaning any stale ones from a previous
// crashed run first). Lot events created during the run are removed by an
// id high-water mark. Sections that operate on the WHOLE pool (buildQueue
// rewrites the queue and clears lot_events) are SKIPPED when non-fixture
// sales or non-fixture lot events exist, so real draft data is never touched.

import { readFileSync } from "node:fs";
import postgres from "postgres";
import { buildConfig, openBidFor, squadSize } from "../lib/config-core.mjs";
import { recordSale } from "../lib/draft-core.mjs";
import {
  buildQueue,
  endPhaseOne,
  noBid,
  nominate,
  pause,
  resume,
  setTv,
} from "../lib/lot-core.mjs";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error(
    "DATABASE_URL not set. Copy .env.example to .env and run with `node --env-file=.env ...`.",
  );
  process.exit(1);
}
const sql = postgres(url, { max: 1 });

let local;
try {
  local = JSON.parse(readFileSync("league.config.local.json", "utf8"));
} catch {
  local = undefined;
}
const cfg = buildConfig(JSON.parse(readFileSync("league.config.json", "utf8")), local);
const SIZE = squadSize(cfg);

// Fixture ids well outside real FPL ranges (test-draft owns 999xxx,
// test-corrections 998xxx; this suite owns 997xxx and manager slots 970-973).
const ID_LO = 997000;
const ID_HI = 997999;
const T1 = [997101, 997102, 997103, 997104]; // FWD tier 1 (the noBid queue)
const T2 = [997201, 997202, 997203]; // MID tier 2
const T3 = [997301, 997302]; // DEF tier 3
const T4 = [997401, 997402]; // GK tier 4
const GHOST_PLAYER = 997990; // in the fixture range but never inserted
const SLOT_A = 970;
const SLOT_B_FULL = 971; // gets a complete 15/15 squad
const SLOT_C = 972;
const SLOT_D = 973;

const ACTOR = "test-lot";

let failed = false;
function report(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed = true;
}

function expectReject(name, result, code) {
  report(
    name,
    result && result.ok === false && result.code === code &&
      typeof result.message === "string" && result.message.length > 0,
    result ? `code = ${result.code}, message = "${result.message}"` : "no result",
  );
}

/** Deterministic seeded rng (mulberry32) so the shuffle is testable. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- fixture management -------------------------------------------------

let savedAppState = null;
let createdAppStateRow = false;
let lotEventsFloor = 0; // rows with id > floor were created by this run
const managerIds = {}; // slot -> id

async function cleanup() {
  await sql`delete from audit_log where actor = ${ACTOR}`;
  if (lotEventsFloor >= 0) {
    await sql`delete from lot_events where id > ${lotEventsFloor}`;
  }
  // Stale fixture events from a crashed previous run (below the floor).
  await sql`delete from lot_events where player_id between ${ID_LO} and ${ID_HI}`;
  // The endPhaseOne section bulk-inserts 'offered' rows for REAL unsold
  // players, marked with sentinel lot_no -9977. Normally the id high-water
  // mark removes them; this catches a crashed run so phantom offer history
  // can never fool a later endPhaseOne.
  await sql`delete from lot_events where lot_no = -9977`;
  await sql`delete from sales where player_id between ${ID_LO} and ${ID_HI}`;
  await sql`delete from players where id between ${ID_LO} and ${ID_HI}`;
  await sql`delete from managers where slot between 970 and 973`;
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

async function appStateRow() {
  const [row] = await sql`select * from app_state where id = 1`;
  return row;
}

/** Insert a fixture sale directly (fixtures, not recordSale). */
async function seedSale(playerId, managerId, price) {
  const [row] = await sql`
    insert into sales (player_id, manager_id, price, lot_no, phase)
    values (${playerId}, ${managerId}, ${price}, ${null}, 1)
    returning id
  `;
  return row.id;
}

/** The first eligible nomination slot after `afterSlot` (null = from start),
 *  computed independently of lot-core: managers by slot, skip squads with
 *  >= SIZE sales, wrap. */
async function expectedNextSlot(afterSlot) {
  const rows = await sql`
    select m.slot, count(s.id)::int as owned
    from managers m left join sales s on s.manager_id = m.id
    group by m.slot order by m.slot
  `;
  const eligible = rows.filter((r) => r.owned < SIZE).map((r) => r.slot);
  if (eligible.length === 0) return null;
  if (afterSlot == null) return eligible[0];
  return eligible.find((s) => s > afterSlot) ?? eligible[0];
}

async function nextLotNoExpected() {
  const [{ next }] = await sql`
    select greatest(
      coalesce((select max(lot_no) from sales), 0),
      coalesce((select max(lot_no) from lot_events), 0)
    ) + 1 as next
  `;
  return Number(next);
}

try {
  await cleanup(); // pre-clean stale fixtures from a previous crashed run

  // app_state singleton: create if missing, else capture the WHOLE row.
  const existingState = await appStateRow();
  if (!existingState) {
    await sql`insert into app_state (id) values (1)`;
    createdAppStateRow = true;
  } else {
    savedAppState = existingState;
  }
  const [{ floor }] = await sql`select coalesce(max(id), 0)::int as floor from lot_events`;
  lotEventsFloor = floor;

  // Fixture managers.
  for (const slot of [SLOT_A, SLOT_B_FULL, SLOT_C, SLOT_D]) {
    const [m] = await sql`
      insert into managers (slot, short, display_order)
      values (${slot}, ${"Lot M" + slot}, ${slot})
      returning id
    `;
    managerIds[slot] = m.id;
  }

  // Fixture players: a spread across all four tiers, plus a full 15-squad of
  // fillers for SLOT_B_FULL (positions per config quotas).
  const players = [
    ...T1.map((id) => ({ id, position: "FWD", fpl_price: 13.0, tier: 1 })),
    ...T2.map((id) => ({ id, position: "MID", fpl_price: 8.0, tier: 2 })),
    ...T3.map((id) => ({ id, position: "DEF", fpl_price: 5.5, tier: 3 })),
    ...T4.map((id) => ({ id, position: "GK", fpl_price: 4.5, tier: 4 })),
  ];
  let nextId = 997900;
  const bFillers = [];
  for (const [pos, count] of Object.entries(cfg.squad)) {
    for (let i = 0; i < count; i++) {
      bFillers.push({ id: nextId++, position: pos, fpl_price: 4.0, tier: 4 });
    }
  }
  const allPlayers = [...players, ...bFillers].map((p) => ({
    id: p.id, code: p.id, web_name: `Lot ${p.id}`, team_short: "TST",
    position: p.position, fpl_price: p.fpl_price, tier: p.tier,
  }));
  await sql`insert into players ${sql(allPlayers, "id", "code", "web_name", "team_short", "position", "fpl_price", "tier")}`;

  // Guards for the whole-pool (destructive) sections.
  const [{ n: nonFixtureSales }] = await sql`
    select count(*)::int as n from sales
    where player_id not between ${ID_LO} and ${ID_HI}
  `;
  const [{ n: nonFixtureEvents }] = await sql`
    select count(*)::int as n from lot_events
    where player_id is null or player_id not between ${ID_LO} and ${ID_HI}
  `;

  // ======================================================================
  // 1. BUILD QUEUE
  // ======================================================================
  console.log("--- buildQueue ---");

  if (nonFixtureSales > 0 || nonFixtureEvents > 0) {
    console.log(
      `SKIP  entire buildQueue section (${nonFixtureSales} non-fixture sales, ` +
        `${nonFixtureEvents} non-fixture lot events exist; buildQueue rewrites the ` +
        "whole queue and clears lot_events)",
    );
  } else {
    await sql`
      update app_state
      set pool_frozen = false, paused = false, phase = 1,
          current_player_id = null, lot_queue = null, nomination_turn = null
      where id = 1
    `;
    expectReject(
      "buildQueue with an unfrozen pool rejects",
      await buildQueue(sql, cfg, { actor: ACTOR }),
      "pool_not_frozen",
    );

    await sql`update app_state set pool_frozen = true where id = 1`;
    await sql`update app_state set paused = true where id = 1`;
    expectReject(
      "buildQueue while paused rejects",
      await buildQueue(sql, cfg, { actor: ACTOR }),
      "paused",
    );
    await sql`update app_state set paused = false where id = 1`;

    let versionBefore = await currentVersion();
    const build1 = await buildQueue(sql, cfg, { actor: ACTOR, rng: mulberry32(1) });
    report("buildQueue on a frozen pool succeeds", build1.ok === true,
      build1.ok ? `${build1.queue.length} lots` : `${build1.code}: ${build1.message}`);

    const allIds = (await sql`select id, tier from players`).map((r) => ({
      id: r.id, tier: r.tier,
    }));
    const tierById = new Map(allIds.map((p) => [p.id, p.tier]));
    // Phase-2-only tiers (Tier 5) are held back for phase-2 nomination, so the
    // phase-1 queue covers the pool minus those tiers.
    const phase2TierSet = new Set(
      cfg.tiers.filter((t) => t.phase2Only === true).map((t) => t.tier),
    );
    const phase1Ids = allIds.filter((p) => !phase2TierSet.has(p.tier));
    const q1 = build1.ok ? build1.queue : [];
    report(
      "queue covers every phase-1 player exactly once (phase-2-only tiers excluded)",
      q1.length === phase1Ids.length && new Set(q1).size === q1.length &&
        phase1Ids.every((p) => q1.includes(p.id)) &&
        q1.every((id) => !phase2TierSet.has(tierById.get(id))),
      `queue ${q1.length}, phase-1 pool ${phase1Ids.length}, full pool ${allIds.length}`,
    );
    let tiersOrdered = true;
    for (let i = 1; i < q1.length; i++) {
      const a = tierById.get(q1[i - 1]) ?? Infinity;
      const b = tierById.get(q1[i]) ?? Infinity;
      if (b < a) tiersOrdered = false;
    }
    report("tier groups are in ascending order (tier 1 first)", tiersOrdered);

    const stateAfterBuild = await appStateRow();
    report(
      "first lot is on the block, phase 1, tv 'block'",
      build1.ok && stateAfterBuild.current_player_id === q1[0] &&
        stateAfterBuild.phase === 1 && stateAfterBuild.tv_view === "block" &&
        stateAfterBuild.nomination_turn === null,
      `current_player_id = ${stateAfterBuild.current_player_id}, queue[0] = ${q1[0]}`,
    );
    const [firstOffered] = await sql`
      select * from lot_events
      where player_id = ${q1[0] ?? -1} and event = 'offered' and lot_no = 1 and phase = 1
    `;
    report("first lot has an 'offered' event (lot_no 1, phase 1)", !!firstOffered);
    report("buildQueue bumps version by exactly 1", (await currentVersion()) === versionBefore + 1);
    const [buildAudit] = await sql`
      select * from audit_log where actor = ${ACTOR} and action = 'lot.build_queue'
      order by id desc limit 1
    `;
    report(
      "buildQueue audit row ('lot.build_queue', player count in payload)",
      buildAudit && buildAudit.after?.players === q1.length,
      buildAudit ? JSON.stringify(buildAudit.after) : "no audit row",
    );

    const build2 = await buildQueue(sql, cfg, { actor: ACTOR, rng: mulberry32(2) });
    const q2 = build2.ok ? build2.queue : [];
    report(
      "two builds with different rng seeds shuffle within tier differently",
      build2.ok && q2.length === q1.length &&
        JSON.stringify(q1) !== JSON.stringify(q2) &&
        new Set(q2).size === q2.length && phase1Ids.every((p) => q2.includes(p.id)),
      "same id set, different order",
    );

    // With any sale on the books, rebuilding must refuse.
    const guardSale = await seedSale(T4[0], managerIds[SLOT_A], 5);
    expectReject(
      "buildQueue with a recorded sale rejects",
      await buildQueue(sql, cfg, { actor: ACTOR }),
      "sales_exist",
    );
    await sql`delete from sales where id = ${guardSale}`;

    // Real offer history (a no_bid row) blocks a rebuild even with zero
    // sales - stale 'offered'/'nominated' rows from a previous build are
    // cleared, but a no-bid is a lot the room actually worked through.
    await sql`
      insert into lot_events (player_id, event, lot_no, phase)
      values (${T1[0]}, 'no_bid', 1, 1)
    `;
    expectReject(
      "buildQueue with recorded no-bid history rejects",
      await buildQueue(sql, cfg, { actor: ACTOR }),
      "auction_started",
    );

    // Reset the events this section wrote so later sections start clean.
    await sql`delete from lot_events where id > ${lotEventsFloor}`;
  }

  // ======================================================================
  // 2. NO BID (phase-1 advance)
  // ======================================================================
  console.log("--- noBid ---");

  const [A1, A2, A3, A4] = T1;
  await sql`
    update app_state
    set phase = 1, paused = false, current_player_id = ${A1},
        tv_view = 'block', reveal_until = null, nomination_turn = null,
        lot_queue = ${sql.json(T1)}
    where id = 1
  `;

  let versionBefore = await currentVersion();
  const nb1 = await noBid(sql, cfg, { actor: ACTOR });
  report(
    "noBid marks the lot and advances to the next queue entry",
    nb1.ok === true && nb1.playerId === A1 && nb1.nextPlayerId === A2 &&
      (await appStateRow()).current_player_id === A2,
    nb1.ok ? `A1 no-bid, next ${nb1.nextPlayerId}` : `${nb1.code}: ${nb1.message}`,
  );
  const [nbEvent] = await sql`
    select * from lot_events where player_id = ${A1} and event = 'no_bid'
  `;
  const [offEvent] = await sql`
    select * from lot_events where player_id = ${A2} and event = 'offered'
  `;
  report(
    "no_bid event (lot_no 1) + offered event for the next lot (lot_no 2)",
    nbEvent?.lot_no === 1 && nbEvent?.phase === 1 && offEvent?.lot_no === 2,
    `no_bid lot ${nbEvent?.lot_no}, offered lot ${offEvent?.lot_no}`,
  );
  report("noBid bumps version by exactly 1", (await currentVersion()) === versionBefore + 1);
  const [nbAudit] = await sql`
    select * from audit_log where actor = ${ACTOR} and action = 'lot.no_bid'
    order by id desc limit 1
  `;
  report("noBid audit row ('lot.no_bid')", !!nbAudit && nbAudit.after?.playerId === A1);

  // Sold-skip: A3 sells (direct insert - fixtures), then a no-bid on A2 must
  // land on A4, skipping the SOLD A3 but never revisiting the no-bid A1.
  const saleA3 = await seedSale(A3, managerIds[SLOT_A], 50);
  const nb2 = await noBid(sql, cfg, { actor: ACTOR });
  report(
    "noBid advance skips a SOLD player (A2 no-bid lands on A4, not A3)",
    nb2.ok === true && nb2.playerId === A2 && nb2.nextPlayerId === A4,
    nb2.ok ? `next ${nb2.nextPlayerId}` : `${nb2.code}: ${nb2.message}`,
  );

  // Forward-only: at the end of the queue there is nothing left - the earlier
  // no-bid A1 is behind the cursor and must NOT come up again in phase 1.
  const nb3 = await noBid(sql, cfg, { actor: ACTOR });
  report(
    "queue is forward-only: a no-bid at the last lot ends with an empty block (A1 never re-offered)",
    nb3.ok === true && nb3.playerId === A4 && nb3.nextPlayerId === null &&
      (await appStateRow()).current_player_id === null,
    nb3.ok ? `next ${nb3.nextPlayerId}` : `${nb3.code}: ${nb3.message}`,
  );
  const [{ n: a1Offers }] = await sql`
    select count(*)::int as n from lot_events
    where player_id = ${A1} and event = 'offered' and id > ${lotEventsFloor}
  `;
  report("no-bid player A1 was never logged 'offered' again", a1Offers === 0, `${a1Offers} offers`);

  expectReject(
    "noBid with no player on the block rejects",
    await noBid(sql, cfg, { actor: ACTOR }),
    "no_lot",
  );

  await sql`update app_state set current_player_id = ${A1}, paused = true where id = 1`;
  expectReject(
    "noBid while paused rejects",
    await noBid(sql, cfg, { actor: ACTOR }),
    "paused",
  );
  await sql`update app_state set paused = false, current_player_id = null where id = 1`;

  // ======================================================================
  // 3. PAUSE / RESUME
  // ======================================================================
  console.log("--- pause / resume ---");

  await sql`update app_state set paused = false, tv_view = 'block' where id = 1`;
  versionBefore = await currentVersion();
  const p1 = await pause(sql, { actor: ACTOR });
  const statePaused = await appStateRow();
  report(
    "pause sets paused + tv 'paused'",
    p1.ok === true && statePaused.paused === true && statePaused.tv_view === "paused",
    `paused = ${statePaused.paused}, tv = ${statePaused.tv_view}`,
  );
  report("pause bumps version by exactly 1", Number(statePaused.version) === versionBefore + 1);
  const [pauseAudit] = await sql`
    select * from audit_log where actor = ${ACTOR} and action = 'auction.pause'
    order by id desc limit 1
  `;
  report("pause audit row ('auction.pause')", !!pauseAudit);

  expectReject("pausing twice rejects", await pause(sql, { actor: ACTOR }), "already_paused");

  const r1 = await resume(sql, { actor: ACTOR });
  const stateResumed = await appStateRow();
  report(
    "resume restores tv 'block' and unpauses",
    r1.ok === true && stateResumed.paused === false && stateResumed.tv_view === "block",
    `paused = ${stateResumed.paused}, tv = ${stateResumed.tv_view}`,
  );
  const [resumeAudit] = await sql`
    select * from audit_log where actor = ${ACTOR} and action = 'auction.resume'
    order by id desc limit 1
  `;
  report("resume audit row ('auction.resume')", !!resumeAudit);
  expectReject("resuming twice rejects", await resume(sql, { actor: ACTOR }), "not_paused");

  // ======================================================================
  // 4. SET TV
  // ======================================================================
  console.log("--- setTv ---");

  // A pending sale-set reveal timer, then a manual override: the override
  // must persist (reveal_until cleared - read-time expiry never kicks in).
  await sql`
    update app_state
    set tv_view = 'block', reveal_until = ${new Date(Date.now() + 8000).toISOString()}
    where id = 1
  `;
  versionBefore = await currentVersion();
  const tv1 = await setTv(sql, { view: "reveal", actor: ACTOR });
  const stateTv = await appStateRow();
  report(
    "setTv 'reveal' persists until changed (reveal_until nulled)",
    tv1.ok === true && stateTv.tv_view === "reveal" && stateTv.reveal_until === null,
    `tv = ${stateTv.tv_view}, reveal_until = ${stateTv.reveal_until}`,
  );
  report("setTv bumps version by exactly 1", Number(stateTv.version) === versionBefore + 1);
  const [tvAudit] = await sql`
    select * from audit_log where actor = ${ACTOR} and action = 'tv.set'
    order by id desc limit 1
  `;
  report("setTv audit row ('tv.set')", !!tvAudit && tvAudit.after?.tvView === "reveal");
  expectReject(
    "setTv with an unknown view rejects",
    await setTv(sql, { view: "scoreboard", actor: ACTOR }),
    "bad_view",
  );
  await setTv(sql, { view: "block", actor: ACTOR });

  // ======================================================================
  // 5. END PHASE ONE
  // ======================================================================
  console.log("--- endPhaseOne ---");

  // Give SLOT_B_FULL a complete 15/15 squad (direct inserts - fixtures).
  for (const p of bFillers) await seedSale(p.id, managerIds[SLOT_B_FULL], 5);

  await sql`
    update app_state
    set phase = 1, paused = false, current_player_id = null,
        nomination_turn = null, lot_queue = ${sql.json(T1)}
    where id = 1
  `;

  // Unoffered players remain (T2/T3/T4 fixtures have no events, plus any real
  // unsold pool): reject, naming the count. Phase-2-only tiers (Tier 5) are
  // never offered in phase 1, so they are excluded from the count - matching
  // endPhaseOne's own query.
  const phase2Tiers = cfg.tiers.filter((t) => t.phase2Only === true).map((t) => t.tier);
  const [{ n: unofferedCount }] = await sql`
    select count(*)::int as n from players p
    where not exists (select 1 from sales s where s.player_id = p.id)
      and not exists (select 1 from lot_events e where e.player_id = p.id)
      ${phase2Tiers.length ? sql`and (p.tier is null or p.tier <> all(${phase2Tiers}))` : sql``}
  `;
  const ep1 = await endPhaseOne(sql, cfg, { actor: ACTOR });
  expectReject("endPhaseOne with unoffered players rejects", ep1, "players_unoffered");
  report(
    "players_unoffered message names how many are still to offer",
    ep1.ok === false && ep1.message.includes(String(unofferedCount)),
    `expected count ${unofferedCount} in "${ep1.message}"`,
  );

  // Offer everything still unoffered (covers real pool players too). These
  // rows carry sentinel lot_no -9977 so the startup pre-clean can find and
  // delete them even if this run crashes before the id high-water-mark
  // cleanup runs - phantom offer history must never fool a later endPhaseOne.
  await sql`
    insert into lot_events (player_id, event, lot_no, phase)
    select p.id, 'offered', -9977, 1 from players p
    where not exists (select 1 from sales s where s.player_id = p.id)
      and not exists (select 1 from lot_events e where e.player_id = p.id)
  `;

  await sql`update app_state set paused = true where id = 1`;
  expectReject(
    "endPhaseOne while paused rejects",
    await endPhaseOne(sql, cfg, { actor: ACTOR }),
    "paused",
  );
  await sql`update app_state set paused = false, current_player_id = ${A2} where id = 1`;
  expectReject(
    "endPhaseOne with a lot still on the block rejects",
    await endPhaseOne(sql, cfg, { actor: ACTOR }),
    "lot_open",
  );
  await sql`update app_state set current_player_id = null where id = 1`;

  const expectedFirstTurn = await expectedNextSlot(null);
  versionBefore = await currentVersion();
  const ep2 = await endPhaseOne(sql, cfg, { actor: ACTOR });
  const stateP2 = await appStateRow();
  report(
    "endPhaseOne passes once every player is offered (phase 2, block + queue cleared)",
    ep2.ok === true && stateP2.phase === 2 && stateP2.current_player_id === null &&
      stateP2.lot_queue === null,
    ep2.ok ? `phase ${stateP2.phase}` : `${ep2.code}: ${ep2.message}`,
  );
  report(
    "first nomination turn is the first eligible slot (complete squads skipped)",
    ep2.ok === true && ep2.nominationTurn === expectedFirstTurn &&
      stateP2.nomination_turn === expectedFirstTurn &&
      ep2.nominationTurn !== SLOT_B_FULL,
    `nomination_turn = ${stateP2.nomination_turn}, expected ${expectedFirstTurn}`,
  );
  report("endPhaseOne bumps version by exactly 1", Number(stateP2.version) === versionBefore + 1);
  const [epAudit] = await sql`
    select * from audit_log where actor = ${ACTOR} and action = 'phase.end_one'
    order by id desc limit 1
  `;
  report("endPhaseOne audit row ('phase.end_one')", !!epAudit && epAudit.after?.phase === 2);
  expectReject(
    "endPhaseOne in phase 2 rejects",
    await endPhaseOne(sql, cfg, { actor: ACTOR }),
    "wrong_phase",
  );
  // The 'auction_complete' rejection needs EVERY manager (including any real
  // seeded ones) to hold a complete squad - not reproducible without writing
  // to real managers, so it is not exercised here.

  // ======================================================================
  // 6. NOMINATE (phase-2 rotation)
  // ======================================================================
  console.log("--- nominate ---");

  await sql`
    update app_state
    set nomination_turn = ${SLOT_A}, current_player_id = null, paused = false
    where id = 1
  `;

  const wrongTurn = await nominate(sql, cfg, {
    playerId: A1, managerSlot: SLOT_C, actor: ACTOR,
  });
  expectReject("nominating out of turn rejects", wrongTurn, "not_your_turn");
  report(
    "not_your_turn message names whose turn it is",
    wrongTurn.ok === false && wrongTurn.message.includes(`Lot M${SLOT_A}`) &&
      wrongTurn.message.includes(`slot ${SLOT_A}`),
    wrongTurn.message,
  );

  expectReject(
    "nominating an unknown player rejects",
    await nominate(sql, cfg, { playerId: GHOST_PLAYER, managerSlot: SLOT_A, actor: ACTOR }),
    "unknown_player",
  );
  expectReject(
    "nominating a SOLD player rejects",
    await nominate(sql, cfg, { playerId: A3, managerSlot: SLOT_A, actor: ACTOR }),
    "already_sold",
  );

  // The right slot nominates A1 - a phase-1 NO BID player (decision 6: any
  // unsold player is nominable, no-bids included).
  const expectedLot = await nextLotNoExpected();
  const expectedAfterA = await expectedNextSlot(SLOT_A); // must skip full 971
  versionBefore = await currentVersion();
  const nom1 = await nominate(sql, cfg, { playerId: A1, managerSlot: SLOT_A, actor: ACTOR });
  const stateNom = await appStateRow();
  report(
    "in-turn nomination of a phase-1 no-bid player is accepted (on the block, tv 'block')",
    nom1.ok === true && stateNom.current_player_id === A1 && stateNom.tv_view === "block",
    nom1.ok ? `lot ${nom1.lotNo}` : `${nom1.code}: ${nom1.message}`,
  );
  const [nomEvent] = await sql`
    select * from lot_events where player_id = ${A1} and event = 'nominated'
    order by id desc limit 1
  `;
  report(
    "nominated event continues the running lot count (phase 2)",
    nomEvent?.phase === 2 && nomEvent?.lot_no === expectedLot,
    `lot_no ${nomEvent?.lot_no}, expected ${expectedLot}`,
  );
  report(
    "turn advances at nomination time, skipping the complete squad (970 -> 972, not 971)",
    nom1.ok === true && nom1.nominationTurn === expectedAfterA &&
      stateNom.nomination_turn === expectedAfterA && expectedAfterA !== SLOT_B_FULL,
    `nomination_turn = ${stateNom.nomination_turn}, expected ${expectedAfterA}`,
  );
  report("nominate bumps version by exactly 1", Number(stateNom.version) === versionBefore + 1);
  const [nomAudit] = await sql`
    select * from audit_log where actor = ${ACTOR} and action = 'lot.nominate'
    order by id desc limit 1
  `;
  report("nominate audit row ('lot.nominate')", !!nomAudit && nomAudit.after?.playerId === A1);

  expectReject(
    "nominating while a lot is still on the block rejects",
    await nominate(sql, cfg, { playerId: A2, managerSlot: expectedAfterA, actor: ACTOR }),
    "lot_open",
  );

  // Phase-2 no-bid: clears the block, reuses the nomination's lot_no, and
  // leaves the turn alone (it already advanced at nomination time).
  const nbP2 = await noBid(sql, cfg, { actor: ACTOR });
  const stateNbP2 = await appStateRow();
  report(
    "phase-2 noBid clears the block with the nomination's lot_no and does not touch the turn",
    nbP2.ok === true && nbP2.phase === 2 && nbP2.lotNo === expectedLot &&
      stateNbP2.current_player_id === null &&
      stateNbP2.nomination_turn === expectedAfterA,
    nbP2.ok ? `lot ${nbP2.lotNo}, turn ${stateNbP2.nomination_turn}` : `${nbP2.code}: ${nbP2.message}`,
  );

  // The same player is nominable AGAIN (nominate -> no-bid -> re-nominate).
  const expectedAfterC = await expectedNextSlot(expectedAfterA);
  const nom2 = await nominate(sql, cfg, {
    playerId: A1, managerSlot: expectedAfterA, actor: ACTOR,
  });
  report(
    "a nominated-then-passed player is nominable again in phase 2",
    nom2.ok === true && nom2.playerId === A1 && nom2.nominationTurn === expectedAfterC,
    nom2.ok ? `turn now ${nom2.nominationTurn}` : `${nom2.code}: ${nom2.message}`,
  );

  // Wrap: the highest eligible slot (fixture D, 973, unless the DB holds
  // higher slots) nominates; the turn wraps past the top of the rotation
  // back to the lowest eligible slot.
  await noBid(sql, cfg, { actor: ACTOR }); // resolve A1 again
  const wrapNominator = expectedAfterC; // whose turn it is now
  const expectedWrap = await expectedNextSlot(wrapNominator);
  const nom3 = await nominate(sql, cfg, {
    playerId: A2, managerSlot: wrapNominator, actor: ACTOR,
  });
  report(
    "turn wraps past the highest slot back to the lowest eligible slot",
    nom3.ok === true && nom3.nominationTurn === expectedWrap && expectedWrap < wrapNominator,
    nom3.ok ? `turn ${wrapNominator} -> ${nom3.nominationTurn} (expected ${expectedWrap})` : `${nom3.code}: ${nom3.message}`,
  );
  await noBid(sql, cfg, { actor: ACTOR }); // resolve A2

  // Phase-2 SALE lot numbering: a sale resolves the nomination that put the
  // player on the block, so recordSale must REUSE the nomination's lot_no
  // (one lot = one number), and the NEXT nomination continues at N+1.
  const lotN = await nextLotNoExpected();
  const nomForSale = await nominate(sql, cfg, {
    playerId: A4, managerSlot: expectedWrap, actor: ACTOR,
  });
  const p2Sale = await recordSale(sql, cfg, {
    playerId: A4, managerId: managerIds[SLOT_A], price: openBidFor(cfg, 1), actor: ACTOR,
  });
  report(
    "phase-2 sale reuses the nomination's lot_no (lot N, not N+1)",
    nomForSale.ok === true && nomForSale.lotNo === lotN &&
      p2Sale.ok === true && p2Sale.sale.lotNo === lotN,
    p2Sale.ok
      ? `nominated lot ${nomForSale.ok ? nomForSale.lotNo : "?"}, sold lot ${p2Sale.sale.lotNo}, expected ${lotN}`
      : `${p2Sale.code}: ${p2Sale.message}`,
  );
  const turnAfterSale = (await appStateRow()).nomination_turn;
  const nomAfterSale = await nominate(sql, cfg, {
    playerId: A1, managerSlot: turnAfterSale, actor: ACTOR,
  });
  report(
    "the nomination after a phase-2 sale gets lot N+1",
    nomAfterSale.ok === true && nomAfterSale.lotNo === lotN + 1,
    nomAfterSale.ok
      ? `lot ${nomAfterSale.lotNo}, expected ${lotN + 1}`
      : `${nomAfterSale.code}: ${nomAfterSale.message}`,
  );
  await noBid(sql, cfg, { actor: ACTOR }); // resolve A1

  await sql`update app_state set phase = 1 where id = 1`;
  expectReject(
    "nominate outside phase 2 rejects",
    await nominate(sql, cfg, { playerId: A1, managerSlot: expectedWrap, actor: ACTOR }),
    "wrong_phase",
  );
  await sql`update app_state set phase = 2, paused = true where id = 1`;
  expectReject(
    "nominate while paused rejects",
    await nominate(sql, cfg, { playerId: A1, managerSlot: expectedWrap, actor: ACTOR }),
    "paused",
  );
  await sql`update app_state set paused = false where id = 1`;
} catch (err) {
  console.error("test-lot failed to run:", err);
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
