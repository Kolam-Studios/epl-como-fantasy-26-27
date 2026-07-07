// Apply db/schema.sql, seed managers from league.config.json (with the
// gitignored league.config.local.json merged on top when present, so the real
// roster seeds on the draft machine), and ensure the app_state singleton row
// exists.
// Usage: npm run db:setup
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";
import { buildConfig } from "../lib/config-core.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set. Copy .env.example to .env and run with `node --env-file=.env ...`.");
  process.exit(1);
}

const sql = postgres(url, { max: 1 });
const schema = readFileSync(join(root, "db", "schema.sql"), "utf8");
const base = JSON.parse(readFileSync(join(root, "league.config.json"), "utf8"));
const localPath = join(root, "league.config.local.json");
const local = existsSync(localPath)
  ? JSON.parse(readFileSync(localPath, "utf8"))
  : undefined;
// Merge + validate; local (real roster) wins. Never print the names.
const config = buildConfig(base, local);

try {
  await sql.unsafe(schema);
  console.log("schema applied");
  // Note: shrinking the config's manager array leaves stale higher-slot rows (fine for v1, fixed roster).
  for (const [i, name] of config.managers.entries()) {
    const slot = i + 1;
    await sql`
      insert into managers (slot, short, display_order)
      values (${slot}, ${name}, ${slot})
      on conflict (slot) do update
        set short = excluded.short, display_order = excluded.display_order
    `;
  }
  console.log(`seeded ${config.managers.length} managers`);
  await sql`insert into app_state (id) values (1) on conflict (id) do nothing`;
  console.log("app_state singleton ensured");
} catch (err) {
  console.error("db:setup failed:", err.message);
  process.exit(1);
} finally {
  await sql.end();
}
