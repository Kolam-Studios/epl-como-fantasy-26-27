// Backfill the completed August auction as archived period 1 ("Bid 1") and
// open the waiver era (docs/DESIGN-WAIVERS.md sections 2.2 / 5 / 7).
//
// What it does (idempotent; safe to re-run):
//   1. seeds the periods table from league.config.json (statuses untouched)
//   2. stamps period_id on the auction-era sales/trades rows (stage 'auction-1')
//   3. freezes period 1's archive snapshot (skipped if already frozen)
//   4. closes period 1, opens the next period, points app_state at it
//
// PRODUCTION NOTE (owner-gated): run against production ONLY after taking the
// pre-deploy snapshot of the auction record. Usage:
//   node --env-file=.env scripts/backfill-period1.mjs
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";
import { buildConfig } from "../lib/config-core.mjs";
import { backfillBidOne } from "../lib/period-core.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set. Run with --env-file pointing at the target database.");
  process.exit(1);
}

const base = JSON.parse(readFileSync(join(root, "league.config.json"), "utf8"));
const localPath = join(root, "league.config.local.json");
const local = existsSync(localPath) ? JSON.parse(readFileSync(localPath, "utf8")) : undefined;
const cfg = buildConfig(base, local);

const sql = postgres(url, { max: 1 });
try {
  const res = await backfillBidOne(sql, cfg, { actor: "backfill-period1" });
  for (const n of res.notes) console.log("-", n);
  if (!res.ok) {
    console.error("backfill FAILED");
    process.exit(1);
  }
  console.log("backfill complete");
} catch (err) {
  console.error("backfill failed:", err.message);
  process.exit(1);
} finally {
  await sql.end();
}
