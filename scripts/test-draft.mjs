// Integration test for the sale transaction (lib/draft-core.mjs) against a
// live DB - no dev server needed, it drives the exact same recordSale the
// route serves.
//
// Usage: node --env-file=.env scripts/test-draft.mjs
//
// Seeds fixture players (999xxx ids) and fixture managers (slots 990+),
// points app_state at a fixture lot queue, then exercises EVERY rejection
// path plus the happy path (sale row, audit row, version bump, tv_view flip,
// lot advance, lot_events). Captures the full app_state row before touching
// it and restores every field in finally; deletes all fixtures.

import { readFileSync } from "node:fs";
import postgres from "postgres";
import { buildConfig, minOpenBid, openBidFor, squadSize } from "../lib/config-core.mjs";
import { recordSale } from "../lib/draft-core.mjs";
import { buildStatePayload } from "../lib/state-core.mjs";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set. Copy .env.example to .env and run with `node --env-file=.env ...`.");
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

// Fixture ids well outside real FPL ranges.
const ID_LO = 999900;
const ID_HI = 999999;
const P_LOT1 = 999910; // FWD, tier 1 - the lot on the block
const P_LOT2 = 999911; // MID, tier 4 - next in queue
const P_LOT3 = 999912; // GK, tier 4 - third in queue (phase-2 case)
const GHOST_PLAYER = 999998; // never inserted
const SLOT_HAPPY = 990;
const SLOT_FULL_SQUAD = 991;
const SLOT_FULL_POS = 992;
const SLOT_MAXBID = 993;

const ACTOR = "test-draft";

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

// --- fixture management -------------------------------------------------

let savedAppState = null;
let createdAppStateRow = false;
const managerIds = {}; // slot -> id

async function cleanup() {
  await sql`
    delete from audit_log
    where action = 'sale.create'
      and (after ->> 'playerId')::int between ${ID_LO} and ${ID_HI}
  `;
  await sql`delete from lot_events where player_id between ${ID_LO} and ${ID_HI}`;
  await sql`delete from sales where player_id between ${ID_LO} and ${ID_HI}`;
  await sql`delete from players where id between ${ID_LO} and ${ID_HI}`;
  await sql`delete from managers where slot between 990 and 993`;
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

  // app_state singleton: create if missing, else capture the WHOLE row.
  const [existingState] = await sql`select * from app_state where id = 1`;
  if (!existingState) {
    await sql`insert into app_state (id) values (1)`;
    createdAppStateRow = true;
  } else {
    savedAppState = existingState;
  }

  // Fixture managers.
  for (const slot of [SLOT_HAPPY, SLOT_FULL_SQUAD, SLOT_FULL_POS, SLOT_MAXBID]) {
    const [m] = await sql`
      insert into managers (slot, short, display_order)
      values (${slot}, ${"Test M" + slot}, ${slot})
      returning id
    `;
    managerIds[slot] = m.id;
  }

  // Fixture players: the three queue lots...
  const playerRows = [
    { id: P_LOT1, code: P_LOT1, web_name: "Test Lot One", team_short: "TST", position: "FWD", fpl_price: 13.0, tier: 1 },
    { id: P_LOT2, code: P_LOT2, web_name: "Test Lot Two", team_short: "TST", position: "MID", fpl_price: 5.0, tier: 4 },
    { id: P_LOT3, code: P_LOT3, web_name: "Test Lot Three", team_short: "TST", position: "GK", fpl_price: 4.5, tier: 4 },
  ];
  // ...a full squad's worth of fillers for the squad-complete manager...
  const fullSquadFiller = [];
  let nextId = 999930;
  for (const [pos, count] of Object.entries(cfg.squad)) {
    for (let i = 0; i < count; i++) {
      fullSquadFiller.push({ id: nextId, code: nextId, web_name: `Filler ${nextId}`, team_short: "TST", position: pos, fpl_price: 4.0, tier: cfg.tiers[cfg.tiers.length - 1].tier });
      nextId++;
    }
  }
  // ...and a full FWD quota for the position-full manager.
  const fwdFiller = [];
  nextId = 999960;
  for (let i = 0; i < cfg.squad.FWD; i++) {
    fwdFiller.push({ id: nextId, code: nextId, web_name: `FWD Filler ${nextId}`, team_short: "TST", position: "FWD", fpl_price: 4.0, tier: cfg.tiers[cfg.tiers.length - 1].tier });
    nextId++;
  }
  const allPlayers = [...playerRows, ...fullSquadFiller, ...fwdFiller];
  await sql`insert into players ${sql(allPlayers, "id", "code", "web_name", "team_short", "position", "fpl_price", "tier")}`;

  // Pre-existing sales: complete squad for one manager, full FWD quota for
  // another (seeded directly, not through recordSale - they are fixtures).
  const reserve = minOpenBid(cfg);
  const fillerSales = [
    ...fullSquadFiller.map((p) => ({ player_id: p.id, manager_id: managerIds[SLOT_FULL_SQUAD], price: reserve, lot_no: null, phase: 1 })),
    ...fwdFiller.map((p) => ({ player_id: p.id, manager_id: managerIds[SLOT_FULL_POS], price: reserve, lot_no: null, phase: 1 })),
  ];
  await sql`insert into sales ${sql(fillerSales, "player_id", "manager_id", "price", "lot_no", "phase")}`;

  // The queue: lot 1 on the block, phase 1, not paused.
  const queue = [P_LOT1, P_LOT2, P_LOT3];
  await sql`
    update app_state
    set phase = 1, paused = false, current_player_id = ${P_LOT1},
        tv_view = 'block', lot_queue = ${sql.json(queue)}
    where id = 1
  `;

  const tier1Open = openBidFor(cfg, 1);
  const versionBefore = await currentVersion();
  const happy = managerIds[SLOT_HAPPY];

  // --- rejections (none of these may write anything) --------------------

  // Whole-table counts so ANY stray write by a rejection shows up.
  const [{ n: auditBefore }] = await sql`select count(*)::int as n from audit_log`;
  const [{ n: lotEventsBefore }] = await sql`select count(*)::int as n from lot_events`;

  await sql`update app_state set paused = true where id = 1`;
  expectReject(
    "paused auction rejects",
    await recordSale(sql, cfg, { playerId: P_LOT1, managerId: happy, price: tier1Open, actor: ACTOR }),
    "paused",
  );
  await sql`update app_state set paused = false where id = 1`;

  expectReject(
    "wrong current lot rejects",
    await recordSale(sql, cfg, { playerId: P_LOT2, managerId: happy, price: tier1Open, actor: ACTOR }),
    "wrong_lot",
  );

  await sql`update app_state set current_player_id = ${GHOST_PLAYER} where id = 1`;
  expectReject(
    "unknown player rejects",
    await recordSale(sql, cfg, { playerId: GHOST_PLAYER, managerId: happy, price: tier1Open, actor: ACTOR }),
    "unknown_player",
  );
  await sql`update app_state set current_player_id = ${P_LOT1} where id = 1`;

  expectReject(
    "unknown manager rejects",
    await recordSale(sql, cfg, { playerId: P_LOT1, managerId: 987654321, price: tier1Open, actor: ACTOR }),
    "unknown_manager",
  );

  expectReject(
    "complete squad rejects",
    await recordSale(sql, cfg, { playerId: P_LOT1, managerId: managerIds[SLOT_FULL_SQUAD], price: tier1Open, actor: ACTOR }),
    "squad_complete",
  );

  expectReject(
    "full position quota rejects",
    await recordSale(sql, cfg, { playerId: P_LOT1, managerId: managerIds[SLOT_FULL_POS], price: tier1Open, actor: ACTOR }),
    "position_full",
  );

  for (const badPrice of [0, -25, 12.5]) {
    expectReject(
      `non-positive-integer price rejects (${badPrice})`,
      await recordSale(sql, cfg, { playerId: P_LOT1, managerId: happy, price: badPrice, actor: ACTOR }),
      "bad_price",
    );
  }

  expectReject(
    "below tier opening bid rejects",
    await recordSale(sql, cfg, { playerId: P_LOT1, managerId: happy, price: tier1Open - 1, actor: ACTOR }),
    "below_open",
  );

  // Fresh manager: maxBid = budget - reserve * (squadSize - 1).
  const expectedMaxBid = cfg.budget - reserve * (squadSize(cfg) - 1);
  const overMax = await recordSale(sql, cfg, {
    playerId: P_LOT1, managerId: managerIds[SLOT_MAXBID], price: expectedMaxBid + 1, actor: ACTOR,
  });
  expectReject("over max bid rejects", overMax, "over_max_bid");
  report(
    "max-bid message carries the max bid and the config reserve",
    overMax.ok === false &&
      overMax.message.includes(`$${expectedMaxBid}`) &&
      overMax.message.includes(`$${reserve} per open slot`),
    overMax.message,
  );

  report(
    "rejections never bump the version",
    (await currentVersion()) === versionBefore,
    `version ${await currentVersion()} vs ${versionBefore}`,
  );
  const [{ n: salesBeforeHappy }] = await sql`
    select count(*)::int as n from sales where player_id in (${P_LOT1}, ${P_LOT2}, ${P_LOT3})
  `;
  report("rejections never insert a sale", salesBeforeHappy === 0);
  const [{ n: auditAfterRejections }] = await sql`select count(*)::int as n from audit_log`;
  const [{ n: lotEventsAfterRejections }] = await sql`select count(*)::int as n from lot_events`;
  report(
    "rejections write zero audit_log rows",
    auditAfterRejections === auditBefore,
    `${auditBefore} -> ${auditAfterRejections}`,
  );
  report(
    "rejections write zero lot_events rows",
    lotEventsAfterRejections === lotEventsBefore,
    `${lotEventsBefore} -> ${lotEventsAfterRejections}`,
  );

  // --- happy path (phase 1) ---------------------------------------------

  const result = await recordSale(sql, cfg, {
    playerId: P_LOT1, managerId: happy, price: tier1Open, actor: ACTOR,
  });
  report(
    "legal sale succeeds with the full sale payload",
    result.ok === true &&
      result.sale.playerId === P_LOT1 &&
      result.sale.managerId === happy &&
      result.sale.price === tier1Open &&
      result.sale.lotNo === 1 &&
      result.sale.phase === 1,
    result.ok ? `sale id ${result.sale.id}, lot ${result.sale.lotNo}` : `rejected: ${result.message}`,
  );
  if (result.ok) {
    report(
      "revealUntil = createdAt + revealMs",
      new Date(result.revealUntil).getTime() ===
        new Date(result.sale.createdAt).getTime() + cfg.revealMs,
    );
  }

  const [saleRow] = await sql`select * from sales where player_id = ${P_LOT1}`;
  report("sale row inserted", saleRow?.manager_id === happy && saleRow?.price === tier1Open);

  const [auditRow] = result.ok
    ? await sql`select * from audit_log where action = 'sale.create' and entity_id = ${result.sale.id}`
    : [];
  report(
    "audit row written (actor, entity, after payload)",
    auditRow &&
      auditRow.actor === ACTOR &&
      auditRow.entity === "sale" &&
      auditRow.before === null &&
      auditRow.after?.playerId === P_LOT1 &&
      auditRow.after?.managerId === happy &&
      auditRow.after?.price === tier1Open &&
      auditRow.after?.lot === 1,
    auditRow ? JSON.stringify(auditRow.after) : "no audit row",
  );

  const [stateAfter] = await sql`select * from app_state where id = 1`;
  report("version bumped by exactly 1", Number(stateAfter.version) === versionBefore + 1);
  report("tv_view flipped to reveal", stateAfter.tv_view === "reveal");
  report(
    "lot advanced to the next unsold queue entry",
    stateAfter.current_player_id === P_LOT2,
    `current_player_id = ${stateAfter.current_player_id}`,
  );
  const [offered] = await sql`
    select * from lot_events where player_id = ${P_LOT2} and event = 'offered'
  `;
  report("lot_events 'offered' written for the new lot", offered?.lot_no === 2 && offered?.phase === 1);

  // --- already sold ------------------------------------------------------

  await sql`update app_state set current_player_id = ${P_LOT1} where id = 1`;
  const resold = await recordSale(sql, cfg, {
    playerId: P_LOT1, managerId: managerIds[SLOT_MAXBID], price: tier1Open, actor: ACTOR,
  });
  expectReject("already-sold player rejects", resold, "already_sold");
  report(
    "already-sold message names the buyer and price",
    resold.ok === false &&
      resold.message.includes(`Test M${SLOT_HAPPY}`) &&
      resold.message.includes(`$${tier1Open}`),
    resold.message,
  );

  // --- happy path (phase 2: nominated lot, block clears) ------------------

  await sql`update app_state set phase = 2, current_player_id = ${P_LOT3} where id = 1`;
  const versionBeforeP2 = await currentVersion();
  const p2 = await recordSale(sql, cfg, {
    playerId: P_LOT3, managerId: happy, price: minOpenBid(cfg), actor: ACTOR,
  });
  const [stateAfterP2] = await sql`select * from app_state where id = 1`;
  report(
    "phase-2 sale succeeds and clears the block (next nomination pending)",
    p2.ok === true && stateAfterP2.current_player_id === null && stateAfterP2.tv_view === "reveal",
    p2.ok ? `current_player_id = ${stateAfterP2.current_player_id}` : `rejected: ${p2.message}`,
  );
  report("phase-2 sale bumps version by exactly 1", Number(stateAfterP2.version) === versionBeforeP2 + 1);

  // --- reveal auto-expiry (state-core, driven by app_state.reveal_until) ---
  // Deterministic: expiry is a stored instant on the singleton row, so these
  // checks never depend on what other (non-fixture) sales exist in the DB.

  if (p2.ok) {
    const [{ reveal_until: ruStored }] = await sql`select reveal_until from app_state where id = 1`;
    report(
      "recordSale stored reveal_until = createdAt + revealMs",
      ruStored != null &&
        new Date(ruStored).getTime() === new Date(p2.sale.createdAt).getTime() + cfg.revealMs &&
        new Date(ruStored).toISOString() === p2.revealUntil,
      `reveal_until = ${ruStored}`,
    );

    const fresh = await buildStatePayload(sql, cfg);
    report("fresh sale: tvView reports 'reveal'", fresh.tvView === "reveal", `tvView = ${fresh.tvView}`);

    // Expiry: a reveal_until in the past must report 'block'. Computed in JS
    // (not DB now()) because state-core compares against the JS clock; a
    // skewed DB clock must not flake this check.
    await sql`
      update app_state
      set reveal_until = ${new Date(Date.now() - 60_000).toISOString()}
      where id = 1
    `;
    const stale = await buildStatePayload(sql, cfg);
    report(
      "expired reveal_until: tvView reports 'block' without a DB write",
      stale.tvView === "block",
      `tvView = ${stale.tvView}`,
    );
    const [{ tv_view: tvStored }] = await sql`select tv_view from app_state where id = 1`;
    report("stored tv_view untouched by the read", tvStored === "reveal");

    // NULL reveal_until = "persist until changed" (the future console set_tv
    // override writes that shape): the reveal must NOT expire.
    await sql`update app_state set reveal_until = null where id = 1`;
    const pinned = await buildStatePayload(sql, cfg);
    report(
      "null reveal_until: 'reveal' persists (console-override shape)",
      pinned.tvView === "reveal",
      `tvView = ${pinned.tvView}`,
    );
  }
} catch (err) {
  console.error("test-draft failed to run:", err);
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
