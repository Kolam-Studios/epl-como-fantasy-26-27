// Integration suite for the waiver RESOLUTION transaction
// (lib/waiver-engine-core.mjs resolveWaiverPeriod): the worked example run
// end-to-end through real submissions, dry-run purity, the one-transaction
// apply (sales/drops/released/audit/close/snapshot/open-next/version), the
// trade blackout, double-resolution safety, and the dropped-player re-sign
// path in the following period.
// Usage: node --env-file=.env scripts/test-waiver-resolution.mjs  (scratch!)
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";
import { buildConfig } from "../lib/config-core.mjs";
import { backfillBidOne, getSnapshot, listPeriods } from "../lib/period-core.mjs";
import { setManagerToken, submitWaiverForm } from "../lib/waiver-core.mjs";
import { resolveWaiverPeriod } from "../lib/waiver-engine-core.mjs";
import { recordTrade } from "../lib/trade-core.mjs";
import { recordSale } from "../lib/draft-core.mjs";
import { editSale, undoLastSale, voidSale } from "../lib/corrections-core.mjs";
import { buildStatePayload } from "../lib/state-core.mjs";
import { buildPlayersPayload } from "../lib/players-core.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set.");
  process.exit(1);
}
const sql = postgres(url, { max: 6 });

const base = JSON.parse(readFileSync(join(root, "league.config.json"), "utf8"));
const localPath = join(root, "league.config.local.json");
const local = existsSync(localPath) ? JSON.parse(readFileSync(localPath, "utf8")) : undefined;
const cfg = buildConfig(base, local);

let failed = false;
function report(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failed = true;
}

try {
  // ---- world: the spec 4.3 example built from REAL rows --------------------
  const managers = await sql`select id, slot, short from managers order by slot`;
  const [mA, mB, mC, mD] = managers;
  const pool = await sql`select id, position from players order by id`;
  const take = (pos, n) => {
    const rows = pool.filter((p) => p.position === pos).slice(0, n);
    if (rows.length < n) throw new Error(`pool too small for ${n} ${pos}`);
    return rows.map((r) => r.id);
  };
  // Free agents FW1..FW4, MF1, DF1, GK1 come AFTER the owned fixtures below.
  const [FWa, FWb, FWc, FWd, FW1, FW2, FW3, FW4] = take("FWD", 8);
  const [MFa, MFb, MF1] = take("MID", 3);
  const [DFa, DF1] = take("DEF", 2);
  const [GKa, GK1] = take("GK", 2);

  // Owned squads priced so start-of-round remaining matches the example:
  // A $120, B $95, C $260, D $40 (budget 3000 each).
  const fixtures = [
    [FWa, mA, 1000], [FWb, mA, 1000], [MFa, mA, 880],           // A: 2880 spent
    [FWc, mB, 2905],                                            // B: 2905
    [MFb, mC, 1370], [DFa, mC, 1370],                           // C: 2740
    [FWd, mD, 1480], [GKa, mD, 1480],                           // D: 2960
  ];
  for (const [pid, m, price] of fixtures) {
    await sql`insert into sales (player_id, manager_id, price) values (${pid}, ${m.id}, ${price})`;
  }
  const bf = await backfillBidOne(sql, cfg, { actor: "test" });
  report("world: Bid 1 archived, Waiver 1 open", bf.ok === true);
  const [waiver1] = await sql`select id, label from periods where seq = 2`;

  for (const [m, word] of [[mA, "alpha"], [mB, "bravo"], [mC, "charlie"], [mD, "delta"]]) {
    await setManagerToken(sql, m.id, word, "test");
  }

  // ---- the four effective forms, submitted through the REAL write path -----
  const forms = [
    [mA, "alpha", [FWa, FWb, MFa], [[FW1, 60], [FW2, 45], [FW3, 30], [MF1, 25], [FW4, 20]]],
    [mB, "bravo", [FWc], [[FW1, 60], [MF1, 40]]],
    [mC, "charlie", [MFb, DFa], [[DF1, 80], [MF1, 50], [FW2, 50]]],
    [mD, "delta", [FWd, GKa], [[FW1, 38], [FW4, 30], [GK1, 25], [FW3, 12]]],
  ];
  for (const [m, word, drops, bids] of forms) {
    const r = await submitWaiverForm(sql, cfg, {
      managerId: m.id, token: word,
      drops: drops.map((playerId) => ({ playerId })),
      bids: bids.map(([playerId, amount]) => ({ playerId, amount })),
      actor: "test",
    });
    report(`form accepted for slot ${m.slot}`, r.ok === true, r.message);
  }

  // ---- before the cutoff: no real resolve, dry-run fine --------------------
  let r = await resolveWaiverPeriod(sql, cfg, { actor: "test" });
  report("real resolve refused before cutoff", r.ok === false && r.code === "before_cutoff");

  const [stateBefore] = await sql`select version from app_state where id = 1`;
  r = await resolveWaiverPeriod(sql, cfg, { dryRun: true, seed: "rehearsal", actor: "test" });
  report("dry-run computes", r.ok === true && r.dryRun === true && r.winCount === 6, `wins ${r.winCount}`);
  const [afterDry] = await sql`select version from app_state where id = 1`;
  const [{ n: resultRows }] = await sql`select count(*)::int as n from waiver_results`;
  const [{ n: salesAfterDry }] = await sql`select count(*)::int as n from sales`;
  const [w1AfterDry] = await sql`select status from periods where id = ${waiver1.id}`;
  report("dry-run writes NOTHING",
    resultRows === 0 && salesAfterDry === fixtures.length &&
    w1AfterDry.status === "open" && Number(afterDry.version) === Number(stateBefore.version));

  // ---- cutoff passes: blackout, then the real run ---------------------------
  // The cutoff moves to THIS instant: the already-made submissions stay
  // before it (effective), and everything from here on is after it.
  await sql`update periods set cutoff_at = now() where id = ${waiver1.id}`;
  const paused = await recordTrade(sql, cfg, {
    managerA: mA.id, managerB: mB.id, playersAToB: [], playersBToA: [],
    cashAToB: 1, cashBToA: 0, actor: "test",
  });
  report("trades paused between cutoff and publication",
    paused.ok === false && paused.code === "trades_paused", paused.message);

  // The blackout holds EVERY money-state mutation, not just trades: a void,
  // edit or manual sale in this window would change the budgets and rosters
  // the forms were final against (adversarial finding, spec 2.3/4.4).
  const [aSale] = await sql`select id from sales where player_id = ${FWa}`;
  const voidTry = await voidSale(sql, cfg, { saleId: aSale.id, reason: "blackout probe", actor: "test" });
  report("sale void paused during the blackout",
    voidTry.ok === false && voidTry.code === "corrections_paused", voidTry.message);
  const editTry = await editSale(sql, cfg, { saleId: aSale.id, price: 999, reason: "blackout probe", actor: "test" });
  report("sale edit paused during the blackout",
    editTry.ok === false && editTry.code === "corrections_paused", editTry.message);
  const undoTry = await undoLastSale(sql, cfg, { actor: "test" });
  report("undo paused during the blackout",
    undoTry.ok === false && undoTry.code === "corrections_paused", undoTry.message);
  const saleTry = await recordSale(sql, cfg, { playerId: GK1, managerId: mA.id, price: 5, actor: "test" });
  report("manual sale paused during the blackout",
    saleTry.ok === false && saleTry.code === "sales_paused", saleTry.message);

  r = await resolveWaiverPeriod(sql, cfg, { seed: "spec-4-3", actor: "test" });
  report("real resolve applies", r.ok === true && r.applied === true, r.message);
  report("resolve reports the fixture wins", r.winCount === 6 && r.seed === "spec-4-3");

  // Awards land as sales rows with the period stamp.
  const waiverSales = await sql`
    select player_id, manager_id, price, stage, period_id from sales
    where period_id = ${waiver1.id} and stage = ${waiver1.label}
  `;
  report("6 sales rows stamped with the period label", waiverSales.length === 6);
  const sale = (pid) => waiverSales.find((s) => s.player_id === pid);
  report("award: FW1 to B for $60", sale(FW1)?.manager_id === mB.id && sale(FW1)?.price === 60);
  report("award: FW2 to A for $45", sale(FW2)?.manager_id === mA.id && sale(FW2)?.price === 45);
  report("award: FW3 to A for $30", sale(FW3)?.manager_id === mA.id && sale(FW3)?.price === 30);
  report("award: FW4 to D for $30", sale(FW4)?.manager_id === mD.id && sale(FW4)?.price === 30);
  report("award: MF1 to C for $50", sale(MF1)?.manager_id === mC.id && sale(MF1)?.price === 50);
  report("award: DF1 to C for $80", sale(DF1)?.manager_id === mC.id && sale(DF1)?.price === 80);
  report("GK1 unawarded", sale(GK1) == null);

  // Drops executed only against wins; released flags in the same transaction.
  const dropRows = await sql`select manager_id, player_id from drops where period_id = ${waiver1.id}`;
  const droppedIds = new Set(dropRows.map((d) => d.player_id));
  report("exactly the 6 released drops executed",
    dropRows.length === 6 &&
    [FWa, FWb, FWc, FWd, MFb, DFa].every((id) => droppedIds.has(id)) &&
    !droppedIds.has(MFa) && !droppedIds.has(GKa),
    [...droppedIds].join(","));
  const releasedRows = await sql`select player_id from sales where released = true`;
  report("released flags match the drops table",
    releasedRows.length === 6 && releasedRows.every((s) => droppedIds.has(s.player_id)));

  // Money: derived remaining matches the spec's final table.
  const state = await buildStatePayload(sql, cfg);
  const rem = new Map(state.managers.map((m) => [m.id, m.remaining]));
  report("final remaining: A $45", rem.get(mA.id) === 45, `got ${rem.get(mA.id)}`);
  report("final remaining: B $35", rem.get(mB.id) === 35, `got ${rem.get(mB.id)}`);
  report("final remaining: C $130", rem.get(mC.id) === 130, `got ${rem.get(mC.id)}`);
  report("final remaining: D $10", rem.get(mD.id) === 10, `got ${rem.get(mD.id)}`);

  // Squads: swaps kept every squad at its pre-round size, quotas intact.
  const squads = new Map(state.managers.map((m) => [m.id, m.squad.map((p) => p.playerId)]));
  report("A's squad is MF-a + FW2 + FW3",
    squads.get(mA.id).length === 3 &&
    [MFa, FW2, FW3].every((id) => squads.get(mA.id).includes(id)));
  report("D retained GK-a (unused nomination stays)",
    squads.get(mD.id).includes(GKa) && squads.get(mD.id).includes(FW4) && squads.get(mD.id).length === 2);

  // Lifecycle: period closed + snapshot with the outcome log; next opened.
  const periods = await listPeriods(sql);
  report("Waiver 1 closed, Waiver 2 open, rest untouched",
    periods[1].status === "closed" && periods[2].status === "open" &&
    periods.slice(3).every((p) => p.status === "locked"));
  const snap = await getSnapshot(sql, waiver1.id);
  report("snapshot frozen with seed + outcome log",
    snap?.payload?.waiver?.seed === "spec-4-3" && snap?.payload?.waiver?.outcomes?.length === 14);
  const cur = await sql`select current_period_id, version from app_state where id = 1`;
  report("app points at Waiver 2, version bumped",
    cur[0].current_period_id === periods[2].id && Number(cur[0].version) > Number(afterDry.version));
  const outcomeRows = await sql`
    select count(*)::int as n from waiver_outcomes wo
    join waiver_results wr on wr.id = wo.result_id
    where wr.period_id = ${waiver1.id}
  `;
  report("all 14 outcomes persisted", outcomeRows[0].n === 14);
  const audits = await sql`select count(*)::int as n from audit_log where action = 'waiver.award'`;
  report("every award audited", audits[0].n === 6);

  // Sealing: a dropped player's value re-seals in the live payloads.
  await sql`insert into valuations (player_id, value, generated_at) values (${FWa}, 500, now())
            on conflict (player_id) do update set value = 500`;
  const players = await buildPlayersPayload(sql, cfg);
  const fwaRow = players.players.find((p) => p.id === FWa);
  report("dropped player reads unsold with value re-sealed",
    fwaRow.sold === false && fwaRow.value === null && fwaRow.price === null);

  // Double resolution: no path back into the closed period. The current
  // period is now Waiver 2, whose cutoff is months away, so an UNforced
  // resolve refuses; and nothing can target Waiver 1 again at all.
  const w1Again = await resolveWaiverPeriod(sql, cfg, { seed: "again", actor: "test" });
  report("no path back into Waiver 1 (current period gates on ITS cutoff)",
    w1Again.ok === false && w1Again.code === "before_cutoff", w1Again.code);

  // Trades reopen after publication.
  const reopened = await recordTrade(sql, cfg, {
    managerA: mA.id, managerB: mB.id, playersAToB: [], playersBToA: [],
    cashAToB: 1, cashBToA: 0, actor: "test",
  });
  report("trades reopen once the period closes", reopened.ok === true, reopened.message);

  // ---- Waiver 2: re-sign a dropped player + funds re-validation --------------
  // B (remaining $34 after the $1 trade) nominates FW1 and bids $30 on FW-b
  // (a fresh FA) and $10 on FW-a (dropped last round). A trade then drains B
  // to below $30: the $30 bid must skip for funds, the $10 must still win.
  const w2 = await submitWaiverForm(sql, cfg, {
    managerId: mB.id, token: "bravo",
    drops: [{ playerId: FW1 }],
    bids: [{ playerId: FWb, amount: 30 }, { playerId: FWa, amount: 10 }],
    actor: "test",
  });
  report("W2 form accepted (dropped players are biddable next period)", w2.ok === true, w2.message);
  const drain = await recordTrade(sql, cfg, {
    managerA: mB.id, managerB: mC.id, playersAToB: [], playersBToA: [],
    cashAToB: 10, cashBToA: 0, actor: "test",
  });
  report("post-submission trade recorded (before W2 cutoff)", drain.ok === true, drain.message);

  r = await resolveWaiverPeriod(sql, cfg, { seed: "w2", force: true, actor: "test" });
  report("W2 resolves (forced early, audited)", r.ok === true && r.applied === true, r.message);
  const w2Outcomes = r.outcomes;
  const fwbBid = w2Outcomes.find((o) => o.playerId === FWb);
  const fwaBid = w2Outcomes.find((o) => o.playerId === FWa);
  report("funds re-validated at resolution: $30 bid skips after the drain",
    fwbBid?.outcome === "skipped_funds");
  report("re-sign: dropped FW-a won for $10 by B", fwaBid?.outcome === "won" && fwaBid?.price === 10);
  const fwaSales = await sql`select released, manager_id, price from sales where player_id = ${FWa} order by id`;
  report("FW-a has two sales rows: released $1000 original + active $10 re-sign",
    fwaSales.length === 2 && fwaSales[0].released === true && fwaSales[1].released === false &&
    fwaSales[1].manager_id === mB.id && fwaSales[1].price === 10);
  const stateAfter = await buildStatePayload(sql, cfg);
  const bAfter = stateAfter.managers.find((m) => m.id === mB.id);
  // B: 2905 auction + 60 W1 win + 10 W2 win + 10 cash drained out - 1 cash
  // received = 2984. Nothing refunded for FW-c or FW1 leaving.
  report("B's spend stays sunk across the whole history",
    bAfter.spent === 2984, `spent ${bAfter.spent}`);
  report("B owns FW-a, dropped FW1",
    bAfter.squad.some((p) => p.playerId === FWa) && !bAfter.squad.some((p) => p.playerId === FW1));

  // ---- concurrency: two resolvers race the same period -----------------------
  // Waiver 3 is now open; give it one trivial form and race two real resolves.
  const w3sub = await submitWaiverForm(sql, cfg, {
    managerId: mA.id, token: "alpha", drops: [{ playerId: FW2 }],
    bids: [{ playerId: FWb, amount: 5 }], actor: "test",
  });
  report("W3 form accepted", w3sub.ok === true, w3sub.message);
  const [race1, race2] = await Promise.all([
    resolveWaiverPeriod(sql, cfg, { seed: "race", force: true, actor: "race-1" }),
    resolveWaiverPeriod(sql, cfg, { seed: "race", force: true, actor: "race-2" }),
  ]);
  const okCount = [race1, race2].filter((x) => x.ok === true).length;
  report("double resolution race: exactly one applies", okCount === 1,
    `${JSON.stringify({ r1: race1.ok ? "ok" : race1.code, r2: race2.ok ? "ok" : race2.code })}`);
  const [{ n: w3results }] = await sql`
    select count(*)::int as n from waiver_results wr join periods p on p.id = wr.period_id
    where p.seq = 4
  `;
  report("exactly one result row for the raced period", w3results === 1);
} catch (err) {
  report("suite crashed", false, err.stack ?? err.message);
} finally {
  await sql.end();
}

process.exit(failed ? 1 : 0);
