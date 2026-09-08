// Mid-season pool refresh: bring `players` back in line with the real Premier
// League after a transfer window, WITHOUT touching a single thing the season
// record rests on.
//
// Why this is not `ingest-fpl.mjs`. A full ingest is refused once the pool is
// frozen or any sale exists (issue #5), and rightly so: it rewrites position
// and tier for every row and could corrupt quotas mid-draft. `--stats-only`
// is the safe escape hatch, but it updates EXISTING ids only - it can never
// add the players who arrived in the window, which is exactly what a waiver
// round needs, since the free-agent list is "every player nobody owns".
//
// So this script sits between the two: additive for arrivals, conservative for
// everything already in the pool, and it refuses outright on the two shapes
// that would corrupt a squad rather than quietly writing them.
//
// Usage:
//   node --env-file=.env scripts/refresh-pool.mjs            report only (default)
//   node --env-file=.env scripts/refresh-pool.mjs --apply    write the changes
//
// Testing hook: FPL_FIXTURE=<file> skips the network fetch (bootstrap shape).
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";
import { buildConfig, tierFor, FPL_POSITION } from "../lib/config-core.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set. Run with `node --env-file=.env scripts/refresh-pool.mjs`.");
  process.exit(1);
}

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const unknown = args.filter((a) => a !== "--apply");
if (unknown.length > 0) {
  console.error(`Unknown flag(s): ${unknown.join(", ")}. Supported: --apply.`);
  process.exit(1);
}

const base = JSON.parse(readFileSync(join(root, "league.config.json"), "utf8"));
const localPath = join(root, "league.config.local.json");
const local = existsSync(localPath) ? JSON.parse(readFileSync(localPath, "utf8")) : undefined;
const config = buildConfig(base, local);

const API = "https://fantasy.premierleague.com/api/bootstrap-static/";

// Stat columns this refresh may touch - the same set --stats-only uses.
const STAT_COLS = [
  "pts", "goals", "assists", "bonus", "starts", "minutes",
  "clean_sheets", "saves", "pens_missed", "yellows", "reds", "selected_by",
];

// Everything an ARRIVAL is inserted with. Bio columns bootstrap does not carry
// (nationality, height_cm) and league history (prev_como_*) stay null.
const INSERT_COLS = [
  "id", "code", "web_name", "first_name", "second_name",
  "team_id", "team_short", "team_code", "position", "fpl_price",
  ...STAT_COLS,
  "tier", "age", "overall_rank", "position_rank",
];

/** Integer age in whole years as of today, or null. */
function ageFrom(birthDate) {
  if (!birthDate || typeof birthDate !== "string") return null;
  const born = new Date(birthDate);
  if (Number.isNaN(born.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - born.getFullYear();
  const beforeBirthday =
    now.getMonth() < born.getMonth() ||
    (now.getMonth() === born.getMonth() && now.getDate() < born.getDate());
  if (beforeBirthday) age -= 1;
  return age >= 0 && age < 100 ? age : null;
}

/** Standard competition ranking (ties share a rank; 1 = highest points). */
function assignRanks(rows, key) {
  const sorted = [...rows].sort((a, b) => b.pts - a.pts);
  let rank = 0;
  let prevPts = null;
  for (const [i, row] of sorted.entries()) {
    if (row.pts !== prevPts) {
      rank = i + 1;
      prevPts = row.pts;
    }
    row[key] = rank;
  }
}

async function fetchBootstrap() {
  const fixture = process.env.FPL_FIXTURE;
  if (fixture) return JSON.parse(readFileSync(fixture, "utf8"));
  const res = await fetch(API);
  if (!res.ok) throw new Error(`FPL API ${res.status} ${res.statusText}`);
  return res.json();
}

/** Map bootstrap-static to our wide row shape, ranks included. */
function mapPlayers(data) {
  const teamById = new Map(data.teams.map((t) => [t.id, t]));
  const rows = data.elements
    .filter((e) => FPL_POSITION[e.element_type])
    .map((e) => {
      const team = teamById.get(e.team);
      const fplPrice = e.now_cost / 10;
      const selectedBy = Number.parseFloat(e.selected_by_percent);
      return {
        id: e.id,
        code: e.code,
        web_name: e.web_name,
        first_name: e.first_name,
        second_name: e.second_name,
        team_id: e.team,
        team_short: team?.short_name ?? String(e.team),
        team_code: team?.code ?? null,
        position: FPL_POSITION[e.element_type],
        fpl_price: fplPrice,
        pts: e.total_points,
        goals: e.goals_scored,
        assists: e.assists,
        bonus: e.bonus,
        starts: e.starts,
        minutes: e.minutes,
        clean_sheets: e.clean_sheets,
        saves: e.saves,
        pens_missed: e.penalties_missed,
        yellows: e.yellow_cards,
        reds: e.red_cards,
        selected_by: Number.isFinite(selectedBy) ? selectedBy : null,
        tier: tierFor(config, fplPrice),
        age: ageFrom(e.birth_date),
      };
    });
  assignRanks(rows, "overall_rank");
  for (const pos of ["GK", "DEF", "MID", "FWD"]) {
    assignRanks(rows.filter((r) => r.position === pos), "position_rank");
  }
  return rows;
}

const sql = postgres(url, { max: 1 });

/** Returns false when a guard refused the run (caller sets a non-zero exit). */
async function refreshPool() {
  // --- guard 1: never move the pool under a running resolution -----------
  // The engine resolves against the exact prices, positions and free-agent
  // list the forms were written against; a refresh landing between cutoff and
  // publish would change the inputs after the fact.
  const resolving = await sql`select label from periods where status = 'resolving' order by seq`;
  if (resolving.length > 0) {
    console.error(
      `REFUSED: ${resolving.map((r) => r.label).join(", ")} is resolving. ` +
        "The waiver engine must run on a stable pool - refresh after the results publish.",
    );
    return false;
  }

  const feed = mapPlayers(await fetchBootstrap());
  const byId = new Map(feed.map((r) => [r.id, r]));

  const dbRows = await sql`
    select p.id, p.web_name, p.team_short, p.position, p.fpl_price, p.tier,
           s.manager_id, m.short as owner
    from players p
    left join sales s on s.player_id = p.id and s.released = false
    left join managers m on m.id = s.manager_id`;

  const arrivals = feed.filter((r) => !dbRows.some((d) => d.id === r.id));
  const departed = dbRows.filter((d) => !byId.has(d.id));
  const movedClub = [];
  const movedPosition = [];
  const renamed = [];
  let repriced = 0;
  let retiered = 0;

  for (const d of dbRows) {
    const f = byId.get(d.id);
    if (!f) continue;
    if (f.team_short !== d.team_short) movedClub.push({ d, f });
    if (f.position !== d.position) movedPosition.push({ d, f });
    if (f.web_name !== d.web_name) renamed.push({ d, f });
    if (Number(f.fpl_price) !== Number(d.fpl_price)) repriced++;
    if (f.tier !== d.tier) retiered++;
  }

  // --- the report (always printed, --apply or not) -----------------------
  console.log(`pool: ${dbRows.length} in the database, ${feed.length} in the FPL feed now`);
  console.log(`  arrivals (new to the pool):      ${arrivals.length}`);
  console.log(`  departed (gone from the feed):   ${departed.length}`);
  console.log(`  club changes:                    ${movedClub.length} (${movedClub.filter((c) => c.d.owner).length} on a squad)`);
  console.log(`  position changes:                ${movedPosition.length} (${movedPosition.filter((c) => c.d.owner).length} on a squad)`);
  console.log(`  name changes:                    ${renamed.length}`);
  console.log(`  price changes:                   ${repriced}`);
  console.log(`  tier changes (price-derived):    ${retiered}`);

  if (arrivals.length > 0) {
    console.log("\narrivals:");
    for (const a of [...arrivals].sort((x, y) => x.team_short.localeCompare(y.team_short) || y.pts - x.pts)) {
      console.log(`  ${a.team_short} ${a.position.padEnd(3)} ${a.web_name} (FPL ${a.fpl_price}, tier ${a.tier}, ${a.pts} pts)`);
    }
  }
  if (movedClub.length > 0) {
    console.log("\nclub changes:");
    for (const { d, f } of movedClub) {
      console.log(`  ${d.web_name}: ${d.team_short} -> ${f.team_short}${d.owner ? `   [on ${d.owner}'s squad]` : ""}`);
    }
  }
  if (renamed.length > 0) {
    console.log("\nname changes:");
    for (const { d, f } of renamed) console.log(`  ${d.web_name} -> ${f.web_name}`);
  }

  // --- guard 2: a departed player who is still on a squad ----------------
  const departedOwned = departed.filter((d) => d.owner);
  if (departedOwned.length > 0) {
    console.error(
      "\nREFUSED: these players are on a squad but have left the FPL pool:\n" +
        departedOwned.map((d) => `  ${d.web_name} (${d.team_short}, ${d.owner})`).join("\n") +
        "\nA manager cannot hold a player who is no longer in the league, and this script will not " +
        "invent an answer. The owners need to rule on what happens to the squad slot and the salary, " +
        "and the pool needs a way to retire a row before this can run.",
    );
    return false;
  }
  if (departed.length > 0) {
    console.log(
      `\nnote: ${departed.length} unowned player(s) are gone from the feed. Their rows are left ` +
        "as they are (nothing owns them, and the row is referenced by the auction record); they " +
        "will still show as free agents until the pool gains a way to retire a row.",
    );
  }

  // --- guard 3: a position change on a player who is on a squad ----------
  // Position drives the squad quota and the waiver same-position swap rule.
  // Rewriting it under a manager could put a squad out of shape (3 GKs, 4
  // FWDs) or silently change which drops a bid can be won against.
  const positionOwned = movedPosition.filter((c) => c.d.owner);
  if (positionOwned.length > 0) {
    console.error(
      "\nREFUSED: FPL has reclassified these players, and they are on a squad:\n" +
        positionOwned
          .map((c) => `  ${c.d.web_name} (${c.d.owner}): ${c.d.position} -> ${c.f.position}`)
          .join("\n") +
        "\nPosition drives the quota and the waiver same-position swap, so rewriting it would put a " +
        "squad out of shape. The owners need to rule per player before this can run.",
    );
    return false;
  }

  if (!apply) {
    console.log("\nreport only - nothing written. Re-run with --apply to write these changes.");
    return true;
  }

  // --- apply -------------------------------------------------------------
  // One transaction: arrivals inserted, everyone in the feed refreshed, ranks
  // recomputed across the WHOLE pool (arrivals shift them), audited, version
  // bumped so every open surface repolls.
  const summary = {
    arrivals: arrivals.length,
    departed: departed.length,
    clubChanges: movedClub.length,
    nameChanges: renamed.length,
    priceChanges: repriced,
    tierChanges: retiered,
    poolBefore: dbRows.length,
    poolAfter: dbRows.length + arrivals.length,
    source: process.env.FPL_FIXTURE ? `fixture ${process.env.FPL_FIXTURE}` : API,
  };

  await sql.begin(async (tx) => {
    const CHUNK = 100;
    for (let i = 0; i < arrivals.length; i += CHUNK) {
      await tx`insert into players ${tx(arrivals.slice(i, i + CHUNK), ...INSERT_COLS)}`;
    }

    // Refresh every row that is still in the feed. Position is in this set:
    // guard 3 has already established that no OWNED player's position moved,
    // so the only positions this can rewrite belong to free agents.
    const payload = feed.map((r) => {
      const row = { id: r.id };
      for (const col of [
        "code", "web_name", "first_name", "second_name",
        "team_id", "team_short", "team_code", "position", "fpl_price",
        ...STAT_COLS, "tier", "age", "overall_rank", "position_rank",
      ]) row[col] = r[col];
      return row;
    });
    const statTypes = STAT_COLS
      .map((c) => `${c} ${c === "selected_by" ? "numeric" : "int"}`)
      .join(", ");
    const statSet = STAT_COLS.map((c) => `${c} = v.${c}`).join(", ");
    const result = await tx`
      update players p set
        code = v.code, web_name = v.web_name,
        first_name = v.first_name, second_name = v.second_name,
        team_id = v.team_id, team_short = v.team_short, team_code = v.team_code,
        position = v.position, fpl_price = v.fpl_price,
        ${tx.unsafe(statSet)},
        tier = v.tier, age = v.age,
        overall_rank = v.overall_rank, position_rank = v.position_rank,
        updated = now()
      from jsonb_to_recordset(${tx.json(payload)}) as v(
        id int, code int, web_name text, first_name text, second_name text,
        team_id int, team_short text, team_code int, position text, fpl_price numeric,
        ${tx.unsafe(statTypes)},
        tier int, age int, overall_rank int, position_rank int)
      where p.id = v.id`;
    summary.rowsRefreshed = result.count;

    await tx`
      insert into audit_log (actor, action, entity, before, after, reason)
      values ('commissioner', 'pool.refresh', 'players',
              ${tx.json({ poolSize: dbRows.length })},
              ${tx.json(summary)},
              'mid-season pool refresh after the summer transfer window')`;

    await tx`update app_state set version = version + 1 where id = 1`;
  });

  console.log(
    `\napplied: ${arrivals.length} arrivals inserted, ${summary.rowsRefreshed} rows refreshed. ` +
      `Pool is now ${summary.poolAfter}.`,
  );
  return true;
}

try {
  if (!(await refreshPool())) process.exitCode = 1;
} catch (err) {
  console.error("pool refresh failed:", err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
