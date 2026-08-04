// Integration suite for the waiver form write path + manager tokens
// (docs/DESIGN-WAIVERS.md 3B/3C): token auth, the full server-side validation
// matrix, resubmission/effective-form semantics, secrecy properties and the
// token history lookup.
// Usage: node --env-file=.env scripts/test-waiver-form.mjs   (scratch DB!)
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";
import { buildConfig } from "../lib/config-core.mjs";
import { backfillBidOne } from "../lib/period-core.mjs";
import {
  foldToken,
  hashManagerToken,
  setManagerToken,
  verifyManagerToken,
  waiverContext,
  submitWaiverForm,
  latestSubmission,
  tokenHistory,
} from "../lib/waiver-core.mjs";
import { buildStatePayload } from "../lib/state-core.mjs";

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
  // ---- pure helpers ---------------------------------------------------------
  report("token folding is case/space-insensitive", foldToken("  Norway ") === "norway");
  report("hash is fold-stable", hashManagerToken("NORWAY") === hashManagerToken("norway"));
  report("hash never stores the word", !hashManagerToken("norway").includes("norway"));

  // ---- world: open Waiver 1 -------------------------------------------------
  const managers = await sql`select id, slot, short, sat_out from managers order by slot`;
  const mA = managers[0], mB = managers[1], mC = managers[2];
  const pool = await sql`select id, position from players order by id`;
  const byPos = (pos) => pool.filter((p) => p.position === pos);
  // A owns 2 MID + 1 FWD; B owns 1 DEF. Everyone else empty.
  const aMid1 = byPos("MID")[0], aMid2 = byPos("MID")[1], aFwd = byPos("FWD")[0];
  const bDef = byPos("DEF")[0];
  const freeMid = byPos("MID")[2], freeMid2 = byPos("MID")[3], freeFwd = byPos("FWD")[1], freeGk = byPos("GK")[0];
  for (const [pl, m, price] of [[aMid1, mA, 200], [aMid2, mA, 150], [aFwd, mA, 100], [bDef, mB, 120]]) {
    await sql`insert into sales (player_id, manager_id, price) values (${pl.id}, ${m.id}, ${price})`;
  }
  const bf = await backfillBidOne(sql, cfg, { actor: "test" });
  report("world: Waiver 1 open", bf.ok === true);

  // ---- tokens ----------------------------------------------------------------
  await setManagerToken(sql, mA.id, "NORWAY", "test");
  await setManagerToken(sql, mB.id, "BRUNO", "test");
  report("verify: right token", await verifyManagerToken(sql, mA.id, "norway"));
  report("verify: wrong token", !(await verifyManagerToken(sql, mA.id, "bruno")));
  report("verify: no token row", !(await verifyManagerToken(sql, mC.id, "anything")));
  await setManagerToken(sql, mA.id, "NORWAY", "test"); // rotate to same word
  const rotated = await sql`select rotated_at from manager_tokens where manager_id = ${mA.id}`;
  report("rotation stamps rotated_at", rotated[0].rotated_at != null);
  const tokenAudits = await sql`select count(*)::int as n from audit_log where action in ('token.create','token.rotate')`;
  report("token writes audited", tokenAudits[0].n >= 3);
  const leak = await sql`select count(*)::int as n from audit_log where before::text ilike '%norway%' or after::text ilike '%norway%'`;
  report("token word never in audit rows", leak[0].n === 0);

  // ---- context (step 1) -------------------------------------------------------
  let ctx = await waiverContext(sql, cfg, { managerId: mA.id, token: "Norway" });
  report("context: pair match", ctx.ok === true);
  report("context: remaining derived", ctx.remaining === cfg.budget - 450, `got ${ctx.remaining}`);
  report("context: squad listed", ctx.squad?.length === 3);
  report("context: no saved form yet", ctx.saved === null);
  ctx = await waiverContext(sql, cfg, { managerId: mA.id, token: "BRUNO" });
  const wrongPairMsg = ctx.message;
  report("context: wrong token generic reject", ctx.ok === false && ctx.code === "no_match");
  ctx = await waiverContext(sql, cfg, { managerId: 999999, token: "NORWAY" });
  report("context: unknown manager SAME generic reject", ctx.ok === false && ctx.message === wrongPairMsg);

  // ---- submit: validation matrix ----------------------------------------------
  const submit = (args) => submitWaiverForm(sql, cfg, { actor: "test", ...args });
  let r = await submit({ managerId: mA.id, token: "wrong", drops: [], bids: [] });
  report("submit: bad token rejected", r.ok === false && r.code === "no_match");
  r = await submit({ managerId: mA.id, token: "norway", drops: [{ playerId: bDef.id }], bids: [] });
  report("submit: drop not owned rejected", r.ok === false && r.code === "drop_not_owned");
  r = await submit({ managerId: mA.id, token: "norway", drops: [], bids: [{ playerId: bDef.id, amount: 10 }] });
  report("submit: bid on owned player rejected", r.ok === false && r.code === "not_free_agent");
  r = await submit({ managerId: mA.id, token: "norway", drops: [], bids: [{ playerId: freeMid.id, amount: 0 }] });
  report("submit: $0 bid rejected", r.ok === false && r.code === "bad_amount");
  r = await submit({ managerId: mA.id, token: "norway", drops: [], bids: [{ playerId: freeMid.id, amount: 10.5 }] });
  report("submit: fractional bid rejected", r.ok === false && r.code === "bad_amount");
  r = await submit({ managerId: mA.id, token: "norway", drops: [], bids: [{ playerId: freeMid.id, amount: cfg.budget }] });
  report("submit: over-wallet bid rejected", r.ok === false && r.code === "over_cap");
  r = await submit({
    managerId: mA.id, token: "norway", drops: [],
    bids: [{ playerId: freeMid.id, amount: 10 }, { playerId: freeMid.id, amount: 20 }],
  });
  report("submit: duplicate bid rejected", r.ok === false && r.code === "dup_bid");
  r = await submit({
    managerId: mA.id, token: "norway",
    drops: [{ playerId: aMid1.id }, { playerId: aMid1.id }], bids: [],
  });
  report("submit: duplicate drop rejected", r.ok === false && r.code === "dup_drop");
  r = await submit({ managerId: mA.id, token: "norway", drops: [], bids: [{ playerId: 424242, amount: 5 }] });
  report("submit: unknown bid target rejected", r.ok === false && r.code === "unknown_player");

  // Full-wallet cap is the whole remaining wallet, NOT the auction reserve rule.
  r = await submit({
    managerId: mA.id, token: "norway",
    drops: [{ playerId: aMid1.id }],
    bids: [{ playerId: freeMid.id, amount: cfg.budget - 450 }],
  });
  report("submit: full-wallet bid allowed", r.ok === true, r.message);

  // Warning, not a block: bid position with no nominated drop.
  r = await submit({
    managerId: mA.id, token: "norway",
    drops: [{ playerId: aMid1.id }],
    bids: [{ playerId: freeGk.id, amount: 5 }],
  });
  report("submit: unbacked position warns, not blocks", r.ok === true && r.warnings?.length === 1,
    JSON.stringify(r.warnings));

  // ---- resubmission: latest wins ------------------------------------------------
  r = await submit({
    managerId: mA.id, token: "norway",
    drops: [{ playerId: aMid2.id }, { playerId: aMid1.id }, { playerId: aFwd.id }],
    bids: [{ playerId: freeMid.id, amount: 60 }, { playerId: freeMid2.id, amount: 60 }, { playerId: freeFwd.id, amount: 25 }],
  });
  report("submit: full form accepted", r.ok === true, r.message);
  const [{ n: subCount }] = await sql`select count(*)::int as n from waiver_submissions where manager_id = ${mA.id}`;
  report("every submission kept", subCount === 3, `got ${subCount}`);
  const [waiver1] = await sql`select id from periods where seq = 2`;
  const eff = await latestSubmission(sql, waiver1.id, mA.id);
  report("effective form is the latest", eff.drops.length === 3 && eff.bids.length === 3);
  report("drop priority = form order", eff.drops[0].playerId === aMid2.id && eff.drops[0].priority === 1);
  report("bid order preserved (tie-break 2c)", eff.bids[0].playerId === freeMid.id && eff.bids[0].bidOrder === 1);
  ctx = await waiverContext(sql, cfg, { managerId: mA.id, token: "norway" });
  report("context prefills the latest form", ctx.saved?.submissionId === eff.submissionId);

  // ---- secrecy: no open payload carries submissions -----------------------------
  const state = await buildStatePayload(sql, cfg);
  const stateText = JSON.stringify(state);
  report("state payload never mentions waiver bids", !stateText.includes("waiver") || !/"bids"/.test(stateText));
  report("state payload has satOut flags", state.managers.every((m) => typeof m.satOut === "boolean"));

  // ---- sat-out manager rejected --------------------------------------------------
  await sql`update managers set sat_out = true where id = ${mB.id}`;
  r = await submit({ managerId: mB.id, token: "bruno", drops: [], bids: [] });
  report("sat-out manager gets the same generic reject", r.ok === false && r.code === "no_match");
  await sql`update managers set sat_out = false where id = ${mB.id}`;

  // ---- period gates ----------------------------------------------------------------
  await sql`update periods set cutoff_at = now() - interval '1 minute' where id = ${waiver1.id}`;
  r = await submit({ managerId: mA.id, token: "norway", drops: [], bids: [] });
  report("past-cutoff submission rejected", r.ok === false && r.code === "past_cutoff");
  await sql`update periods set cutoff_at = now() + interval '30 days' where id = ${waiver1.id}`;
  await sql`update periods set status = 'resolving' where id = ${waiver1.id}`;
  r = await submit({ managerId: mA.id, token: "norway", drops: [], bids: [] });
  report("resolving-period submission rejected", r.ok === false && r.code === "period_not_open");
  await sql`update periods set status = 'open' where id = ${waiver1.id}`;

  // ---- token history ------------------------------------------------------------------
  let hist = await tokenHistory(sql, "NORWAY");
  report("history: right token finds submissions", hist.found === true && hist.periods.length === 1);
  report("history: superseded versions included", hist.periods[0].submissions.length === 3);
  report("history: newest first", hist.periods[0].submissions[0].submissionId === eff.submissionId);
  const wrong = await tokenHistory(sql, "not-a-token");
  const noSubs = await tokenHistory(sql, "bruno"); // B has a token but zero submissions
  report("history: wrong token and no-submissions look identical",
    JSON.stringify(wrong) === JSON.stringify(noSubs), `${JSON.stringify(wrong)} vs ${JSON.stringify(noSubs)}`);

  // ---- audit trail -----------------------------------------------------------------------
  const [{ n: auditN }] = await sql`select count(*)::int as n from audit_log where action = 'waiver.submit'`;
  report("every submission audited", auditN === subCount, `${auditN} audits for ${subCount} submissions`);
} catch (err) {
  report("suite crashed", false, err.stack ?? err.message);
} finally {
  await sql.end();
}

process.exit(failed ? 1 : 0);
