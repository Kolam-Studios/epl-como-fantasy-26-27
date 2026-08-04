// Integration suite for the periods + archiving foundation (waiver era,
// docs/DESIGN-WAIVERS.md sections 2.2 / 5): seeding idempotency, the status
// lifecycle, snapshot write-once, the Bid 1 backfill (twice - idempotent),
// and period stamping on new sales/trades.
// Usage: node --env-file=.env scripts/test-periods.mjs   (scratch DB!)
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";
import { buildConfig, configPeriods } from "../lib/config-core.mjs";
import {
  seedPeriods,
  listPeriods,
  getCurrentPeriod,
  transitionPeriod,
  freezeSnapshot,
  getSnapshot,
  backfillBidOne,
  currentPeriodStamp,
} from "../lib/period-core.mjs";
import { recordTrade } from "../lib/trade-core.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set.");
  process.exit(1);
}
const sql = postgres(url, { max: 4 });

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
  const defined = configPeriods(cfg);
  report("config defines periods", defined.length >= 2, `got ${defined.length}`);

  // --- seeding: idempotent, statuses untouched -----------------------------
  await seedPeriods(sql, cfg);
  let periods = await listPeriods(sql);
  report("seed creates every configured period", periods.length === defined.length,
    `${periods.length} vs ${defined.length}`);
  report("all periods start locked", periods.every((p) => p.status === "locked"));

  // Mutate a status, re-seed, confirm the status survives but labels converge.
  await sql`update periods set status = 'open' where seq = 2`;
  await seedPeriods(sql, cfg);
  periods = await listPeriods(sql);
  report("re-seed never touches status", periods.find((p) => p.seq === 2)?.status === "open");
  report("re-seed is row-stable", periods.length === defined.length);
  await sql`update periods set status = 'locked' where seq = 2`;

  // --- lifecycle ------------------------------------------------------------
  const p2 = periods.find((p) => p.seq === 2);
  let t = await transitionPeriod(sql, p2.id, "closed", "test");
  report("locked -> closed refused", t.ok === false);
  t = await transitionPeriod(sql, p2.id, "open", "test");
  report("locked -> open allowed", t.ok === true);
  t = await transitionPeriod(sql, p2.id, "resolving", "test");
  report("open -> resolving allowed", t.ok === true);
  t = await transitionPeriod(sql, p2.id, "open", "test");
  report("resolving -> open (abort) allowed", t.ok === true);
  t = await transitionPeriod(sql, p2.id, "resolving", "test");
  t = await transitionPeriod(sql, p2.id, "closed", "test");
  report("resolving -> closed allowed", t.ok === true);
  t = await transitionPeriod(sql, p2.id, "open", "test");
  report("closed is terminal", t.ok === false);
  const audits = await sql`
    select count(*)::int as n from audit_log where action = 'period.transition' and entity_id = ${p2.id}
  `;
  report("every transition audited", audits[0].n >= 5, `got ${audits[0].n}`);
  // reset for backfill below
  await sql`update periods set status = 'locked', opens_at = null where id = ${p2.id}`;

  // --- snapshot write-once ---------------------------------------------------
  let f = await freezeSnapshot(sql, p2.id, { probe: 1 });
  report("snapshot freezes", f.ok === true);
  f = await freezeSnapshot(sql, p2.id, { probe: 2 });
  report("snapshot refuses overwrite", f.ok === false);
  const snap = await getSnapshot(sql, p2.id);
  report("snapshot readable and original", snap?.payload?.probe === 1);
  await sql`delete from period_snapshots where period_id = ${p2.id}`;

  // --- backfill fixtures: a tiny sold world ----------------------------------
  const managers = await sql`select id, slot, short from managers order by slot`;
  report("managers seeded (fixture precondition)", managers.length >= 2);
  const pool = await sql`
    select id, position from players order by id limit 40
  `;
  report("player pool present (fixture precondition)", pool.length >= 6);
  const mA = managers[0], mB = managers[1];
  const byPos = (pos) => pool.filter((p) => p.position === pos);
  // Give A and B a couple of auction sales each (stage default 'auction-1').
  const fixtures = [
    { p: byPos("MID")[0], m: mA, price: 100 },
    { p: byPos("FWD")[0], m: mA, price: 80 },
    { p: byPos("MID")[1], m: mB, price: 60 },
    { p: byPos("DEF")[0], m: mB, price: 40 },
  ].filter((f) => f.p);
  report("fixture positions available", fixtures.length === 4);
  for (const fx of fixtures) {
    await sql`insert into sales (player_id, manager_id, price) values (${fx.p.id}, ${fx.m.id}, ${fx.price})`;
  }
  // One auction-era trade between them (cash only).
  const trade = await recordTrade(sql, cfg, {
    managerA: mA.id, managerB: mB.id, playersAToB: [], playersBToA: [],
    cashAToB: 10, cashBToA: 0, actor: "test",
  });
  report("fixture trade recorded", trade.ok === true, trade.ok ? "" : trade.message);

  // --- backfill: Bid 1 becomes the closed archive, next period opens ---------
  const res1 = await backfillBidOne(sql, cfg, { actor: "test" });
  report("backfill runs", res1.ok === true, res1.notes.join("; "));
  periods = await listPeriods(sql);
  const bid1 = periods[0];
  const next = periods[1];
  report("Bid 1 closed", bid1.status === "closed");
  report("Bid 1 snapshot frozen", bid1.hasSnapshot === true);
  report("next period open", next.status === "open");
  const current = await getCurrentPeriod(sql);
  report("app_state points at the open period", current?.id === next.id, `current=${current?.label}`);

  const unstamped = await sql`select count(*)::int as n from sales where period_id is null`;
  report("every auction sale stamped", unstamped[0].n === 0, `${unstamped[0].n} unstamped`);
  const unstampedTrades = await sql`select count(*)::int as n from trades where period_id is null and voided = false`;
  report("every auction trade stamped", unstampedTrades[0].n === 0);

  // Snapshot content sanity: budgets for every manager, our fixtures visible.
  const snap1 = await getSnapshot(sql, bid1.id);
  const recap = snap1?.payload?.recap;
  report("snapshot carries recap budgets", Array.isArray(recap?.managers) && recap.managers.length === managers.length,
    `got ${recap?.managers?.length}`);
  report("snapshot carries the ledger", Array.isArray(snap1?.payload?.players?.players) && snap1.payload.players.players.length > 0);
  report("snapshot carries this period's trades", (snap1?.payload?.trades?.trades ?? []).length === 1);
  // Total spend across managers: 280 in auction buys; the trade's cash nets
  // to zero across the two sides (+10 for A, -10 for B).
  report("snapshot spend matches fixtures",
    recap?.managers?.reduce((s, m) => s + (m.spent ?? 0), 0) === 280,
    `total spent ${recap?.managers?.reduce((s, m) => s + (m.spent ?? 0), 0)}`);

  // --- backfill is idempotent -------------------------------------------------
  const res2 = await backfillBidOne(sql, cfg, { actor: "test" });
  report("backfill re-run ok", res2.ok === true, res2.notes.join("; "));
  const snapAgain = await getSnapshot(sql, bid1.id);
  report("re-run leaves snapshot untouched",
    JSON.stringify(snapAgain.payload.recap.managers) === JSON.stringify(snap1.payload.recap.managers));
  const periodsAgain = await listPeriods(sql);
  report("re-run leaves statuses stable",
    JSON.stringify(periodsAgain.map((p) => p.status)) === JSON.stringify(periods.map((p) => p.status)));

  // --- new writes stamp the CURRENT period ------------------------------------
  const [appState] = await sql`select current_period_id from app_state where id = 1`;
  const stamp = await currentPeriodStamp(sql, appState);
  report("currentPeriodStamp resolves", stamp?.periodId === next.id && stamp?.stage === next.label);
  const trade2 = await recordTrade(sql, cfg, {
    managerA: mA.id, managerB: mB.id, playersAToB: [], playersBToA: [],
    cashAToB: 0, cashBToA: 5, actor: "test",
  });
  report("waiver-era trade recorded", trade2.ok === true, trade2.ok ? "" : trade2.message);
  const [t2] = await sql`select stage, period_id from trades where id = ${trade2.trade?.id ?? trade2.tradeId ?? 0}`;
  const t2row = t2 ?? (await sql`select stage, period_id from trades order by id desc limit 1`)[0];
  report("waiver-era trade stamped with period label + id",
    t2row.stage === next.label && t2row.period_id === next.id,
    `stage=${t2row.stage} period_id=${t2row.period_id}`);
} catch (err) {
  report("suite crashed", false, err.stack ?? err.message);
} finally {
  await sql.end();
}

process.exit(failed ? 1 : 0);
