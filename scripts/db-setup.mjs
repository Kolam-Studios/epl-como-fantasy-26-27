// Apply db/schema.sql and seed managers from league.config.json.
// Usage: npm run db:setup
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set. Copy .env.example to .env.local.");
  process.exit(1);
}

const sql = postgres(url, { max: 1 });
const schema = readFileSync(join(root, "db", "schema.sql"), "utf8");
const config = JSON.parse(readFileSync(join(root, "league.config.json"), "utf8"));

try {
  await sql.unsafe(schema);
  console.log("schema applied");
  for (const name of config.managers) {
    await sql`insert into managers (name) values (${name}) on conflict (name) do nothing`;
  }
  console.log(`seeded ${config.managers.length} managers:`, config.managers.join(", "));
} catch (err) {
  console.error("db:setup failed:", err.message);
  process.exit(1);
} finally {
  await sql.end();
}
