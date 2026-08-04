// Integration suite for manager administration (mockup H item 2): the
// sit-out toggle and its effects on the rotation and waiver surfaces.
// Usage: node --env-file=.env scripts/test-managers.mjs   (scratch DB!)
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";
import { buildConfig } from "../lib/config-core.mjs";
import { setSatOut } from "../lib/managers-core.mjs";
import { buildStatePayload } from "../lib/state-core.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set.");
  process.exit(1);
}
const sql = postgres(url, { max: 2 });

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
  const [mgr] = await sql`select id, slot, short from managers order by slot limit 1`;
  const [before] = await sql`select version from app_state where id = 1`;

  let r = await setSatOut(sql, cfg, { managerId: 424242, satOut: true, actor: "test" });
  report("unknown manager rejected", r.ok === false && r.code === "unknown_manager");
  r = await setSatOut(sql, cfg, { managerId: mgr.id, satOut: "yes", actor: "test" });
  report("non-boolean flag rejected", r.ok === false && r.code === "bad_flag");

  r = await setSatOut(sql, cfg, { managerId: mgr.id, satOut: true, actor: "test" });
  report("sit-out set", r.ok === true && r.changed === true && r.satOut === true);
  const [after] = await sql`select version from app_state where id = 1`;
  report("version bumped", Number(after.version) === Number(before.version) + 1);
  const state = await buildStatePayload(sql, cfg);
  report("state payload reflects the flag",
    state.managers.find((m) => m.id === mgr.id)?.satOut === true);

  r = await setSatOut(sql, cfg, { managerId: mgr.id, satOut: true, actor: "test" });
  report("idempotent re-set changes nothing", r.ok === true && r.changed === false);
  const [same] = await sql`select version from app_state where id = 1`;
  report("no version bump on a no-op", Number(same.version) === Number(after.version));

  r = await setSatOut(sql, cfg, { managerId: mgr.id, satOut: false, actor: "test" });
  report("rejoin instantly", r.ok === true && r.changed === true && r.satOut === false);

  const audits = await sql`select count(*)::int as n from audit_log where action = 'manager.sit_out'`;
  report("both real toggles audited", audits[0].n === 2, `got ${audits[0].n}`);
} catch (err) {
  report("suite crashed", false, err.stack ?? err.message);
} finally {
  await sql.end();
}

process.exit(failed ? 1 : 0);
