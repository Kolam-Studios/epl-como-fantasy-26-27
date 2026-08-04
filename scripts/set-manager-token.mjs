// Set or rotate one manager's waiver token (Commissioners only, run locally).
// The token is hashed before storage and NEVER printed, logged or committed.
// Real assignments live outside the repo entirely.
//
// Usage:
//   node --env-file=.env scripts/set-manager-token.mjs --slot 3 --token SOMEWORD
//
// Tokens are compared case-insensitively (one memorable word per manager).
import postgres from "postgres";
import { setManagerToken } from "../lib/waiver-core.mjs";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set.");
  process.exit(1);
}

const args = process.argv.slice(2);
const get = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const slot = Number(get("--slot"));
const token = get("--token");
if (!Number.isInteger(slot) || !token || token.trim() === "") {
  console.error("usage: set-manager-token.mjs --slot <n> --token <word>");
  process.exit(1);
}

const sql = postgres(url, { max: 1 });
try {
  const [mgr] = await sql`select id, slot from managers where slot = ${slot}`;
  if (!mgr) {
    console.error(`no manager at slot ${slot}`);
    process.exit(1);
  }
  await setManagerToken(sql, mgr.id, token, "commissioner");
  console.log(`token set for manager slot ${slot} (hash stored, word not shown)`);
} catch (err) {
  console.error("set-manager-token failed:", err.message);
  process.exit(1);
} finally {
  await sql.end();
}
