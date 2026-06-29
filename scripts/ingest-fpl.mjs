// Pull the FPL player pool into the players table.
// Source: https://fantasy.premierleague.com/api/bootstrap-static/ (public, no auth).
// Usage: npm run ingest
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

const FPL_POSITION = { 1: "GK", 2: "DEF", 3: "MID", 4: "FWD" };

// Crude price-band tier (lower number = pricier). Refine later if wanted.
function tierFor(price) {
  if (price >= 9) return 1;
  if (price >= 7) return 2;
  if (price >= 5.5) return 3;
  if (price >= 4.5) return 4;
  return 5;
}

const API = "https://fantasy.premierleague.com/api/bootstrap-static/";

const res = await fetch(API);
if (!res.ok) {
  console.error(`FPL API ${res.status} ${res.statusText}`);
  process.exit(1);
}
const data = await res.json();
const teamById = new Map(data.teams.map((t) => [t.id, t.short_name]));

const rows = data.elements
  // GK/DEF/MID/FWD only. Guard against any non-player element type the FPL API
  // might expose (verified 4 types as of 2026-06, but stay defensive).
  .filter((e) => FPL_POSITION[e.element_type])
  .map((e) => ({
  id: e.id,
  name: e.web_name,
  team: teamById.get(e.team) ?? String(e.team),
  position: FPL_POSITION[e.element_type],
  value: e.now_cost / 10,
  tier: tierFor(e.now_cost / 10),
}));

const sql = postgres(url, { max: 1 });
try {
  let n = 0;
  for (const r of rows) {
    await sql`
      insert into players (id, name, team, position, value, tier, updated)
      values (${r.id}, ${r.name}, ${r.team}, ${r.position}, ${r.value}, ${r.tier}, now())
      on conflict (id) do update set
        name = excluded.name, team = excluded.team, position = excluded.position,
        value = excluded.value, tier = excluded.tier, updated = now()`;
    n++;
  }
  console.log(`ingested ${n} players from FPL`);
} catch (err) {
  console.error("ingest failed:", err.message);
  process.exit(1);
} finally {
  await sql.end();
}
