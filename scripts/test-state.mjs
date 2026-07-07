// Integration test for the /api/state assembly (lib/state-core.mjs) against
// a live DB - no dev server needed, it drives the same buildStatePayload the
// route serves.
//
// Usage: node --env-file=.env scripts/test-state.mjs
//
// Seeds two fake players (999xxx ids), a valuation for BOTH, a sale for one,
// and points app_state.current_player_id at the UNSOLD one. Asserts the
// sealed-valuation rule structurally (the unsold player's value must not
// appear ANYWHERE in the payload), the sold player's value DOES surface in
// recentSales, the money arithmetic is exact, and version passes through.
// Cleans up all fixtures and restores every app_state field it touched.

import { readFileSync } from "node:fs";
import postgres from "postgres";
import { buildConfig, minOpenBid, squadSize } from "../lib/config-core.mjs";
import { buildStatePayload } from "../lib/state-core.mjs";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set. Copy .env.example to .env and run with `node --env-file=.env ...`.");
  process.exit(1);
}
const sql = postgres(url, { max: 1 });

// Same config path as the app (base + optional local override).
let local;
try {
  local = JSON.parse(readFileSync("league.config.local.json", "utf8"));
} catch {
  local = undefined;
}
const cfg = buildConfig(JSON.parse(readFileSync("league.config.json", "utf8")), local);

// Fixture ids well outside real FPL ranges.
const UNSOLD_ID = 999901; // the current lot; its valuation must stay sealed
const SOLD_ID = 999902;
const UNSOLD_VALUE = 987654; // distinctive: must not appear anywhere in the payload
const SOLD_VALUE = 500;
const SALE_PRICE = 601;
const MANAGER_SLOT = 1;

let failed = false;
function report(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed = true;
}

// Deep-scan an object tree for any key whose name smells like a valuation.
function findValuationKeys(node, path = "") {
  const hits = [];
  if (Array.isArray(node)) {
    node.forEach((v, i) => hits.push(...findValuationKeys(v, `${path}[${i}]`)));
  } else if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (/value|valuation/i.test(k)) hits.push(`${path}.${k}`);
      hits.push(...findValuationKeys(v, `${path}.${k}`));
    }
  }
  return hits;
}

// --- fixture management -------------------------------------------------

let savedAppState = null; // fields we touch, captured before mutation
let createdAppStateRow = false;
let createdManagerId = null; // if we had to create manager slot 1

async function cleanup() {
  await sql`delete from sales where player_id in (${UNSOLD_ID}, ${SOLD_ID})`;
  await sql`delete from valuations where player_id in (${UNSOLD_ID}, ${SOLD_ID})`;
  await sql`delete from players where id in (${UNSOLD_ID}, ${SOLD_ID})`;
  if (createdManagerId !== null) {
    await sql`delete from managers where id = ${createdManagerId}`;
    createdManagerId = null;
  }
  if (createdAppStateRow) {
    await sql`delete from app_state where id = 1`;
    createdAppStateRow = false;
  } else if (savedAppState) {
    await sql`
      update app_state
      set current_player_id = ${savedAppState.current_player_id}
      where id = 1
    `;
    savedAppState = null;
  }
}

try {
  await cleanup(); // in case a previous run died mid-way

  // Manager slot 1 (create only if the seed hasn't run).
  let [manager] = await sql`select id, slot, short from managers where slot = ${MANAGER_SLOT}`;
  if (!manager) {
    [manager] = await sql`
      insert into managers (slot, short, display_order)
      values (${MANAGER_SLOT}, 'Manager 1', ${MANAGER_SLOT})
      returning id, slot, short
    `;
    createdManagerId = manager.id;
  }

  // app_state singleton: create if missing, else save the fields we touch.
  const [existingState] = await sql`select current_player_id from app_state where id = 1`;
  if (!existingState) {
    await sql`insert into app_state (id) values (1)`;
    createdAppStateRow = true;
  } else {
    savedAppState = existingState;
  }

  // Players: one to sell, one to put on the block unsold.
  await sql`
    insert into players (id, code, web_name, team_short, position, fpl_price, tier, pts)
    values (${UNSOLD_ID}, ${UNSOLD_ID}, 'Test Unsold', 'TST', 'MID', 9.5, 2, 111),
           (${SOLD_ID},   ${SOLD_ID},   'Test Sold',   'TST', 'FWD', 12.5, 1, 222)
  `;
  // Valuations for BOTH - the whole point is that only the sold one leaks out.
  await sql`
    insert into valuations (player_id, value, generated_at)
    values (${UNSOLD_ID}, ${UNSOLD_VALUE}, now()),
           (${SOLD_ID}, ${SOLD_VALUE}, now())
  `;
  // Sell one to manager slot 1; put the unsold one on the block.
  await sql`
    insert into sales (player_id, manager_id, price, lot_no, phase)
    values (${SOLD_ID}, ${manager.id}, ${SALE_PRICE}, 999, 1)
  `;
  await sql`update app_state set current_player_id = ${UNSOLD_ID} where id = 1`;

  // Expected manager-1 numbers from ALL their sales (pre-existing + fixture).
  const managerSales = await sql`select price from sales where manager_id = ${manager.id}`;
  const expectedSpent = managerSales.reduce((s, r) => s + r.price, 0);
  const expectedRemaining = cfg.budget - expectedSpent;
  const expectedOpen = squadSize(cfg) - managerSales.length;
  const expectedMaxBid =
    expectedOpen <= 0 ? null : expectedRemaining - minOpenBid(cfg) * (expectedOpen - 1);

  const [{ version: dbVersion }] = await sql`select version from app_state where id = 1`;

  // --- the payload under test ---
  const payload = await buildStatePayload(sql, cfg);

  // (a) currentLot carries no value/valuation key anywhere.
  report(
    "currentLot is the unsold fixture",
    payload.currentLot?.id === UNSOLD_ID,
    `currentLot.id = ${payload.currentLot?.id}`,
  );
  const hits = findValuationKeys(payload.currentLot);
  report(
    "currentLot has no value/valuation key anywhere (deep scan)",
    hits.length === 0,
    hits.join(", "),
  );

  // (b) the unsold player's valuation number appears nowhere in the payload.
  const raw = JSON.stringify(payload);
  report(
    "payload never contains the unsold player's valuation number",
    !raw.includes(String(UNSOLD_VALUE)),
  );

  // (c) the sold player's recentSales entry DOES carry its valuation.
  const soldEntry = payload.recentSales.find((s) => s.playerId === SOLD_ID);
  report(
    "sold player's recentSales entry carries its valuation",
    soldEntry?.value === SOLD_VALUE,
    `value = ${soldEntry?.value}`,
  );
  report(
    "sold entry verdict matches v1 logic (601 vs 500 -> OVERPAY +101)",
    soldEntry?.verdict === "OVERPAY" && soldEntry?.delta === SALE_PRICE - SOLD_VALUE,
    `verdict = ${soldEntry?.verdict}, delta = ${soldEntry?.delta}`,
  );

  // (d) manager 1 arithmetic is exact.
  const m1 = payload.managers.find((m) => m.slot === MANAGER_SLOT);
  report(
    "manager 1 spent/remaining/maxBid arithmetic exact",
    m1 &&
      m1.spent === expectedSpent &&
      m1.remaining === expectedRemaining &&
      m1.openSlots === expectedOpen &&
      m1.maxBid === expectedMaxBid,
    m1
      ? `spent ${m1.spent}/${expectedSpent}, remaining ${m1.remaining}/${expectedRemaining}, maxBid ${m1.maxBid}/${expectedMaxBid}`
      : "manager slot 1 missing from payload",
  );

  // (e) version passes straight through from app_state.
  report(
    "payload version equals app_state.version",
    payload.version === Number(dbVersion),
    `payload ${payload.version}, db ${dbVersion}`,
  );
} catch (err) {
  console.error("test-state failed to run:", err.message);
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
