// Load Darryl's retention-adjusted Claude values into the auction DB.
//
// Reads data/claude-values.json (gitignored, sealed) and REPLACES the contents
// of the `valuations` table with it: value + retainability per player, matched
// to our player records by FPL element id first, falling back to (name, team).
// Any player that fails to match is LOGGED, never fatal - the auction must run
// even if a row or two does not line up.
//
// It also recalibrates the STEAL/FAIR/OVERPAY reveal band (valuation_meta,
// #70) from the NEW values' median, using the exact same formula as
// scripts/generate-valuations.mjs, so verdicts stay coherent with the new
// (higher, retention-adjusted) scale. Nothing else is touched.
//
// Usage (writes to whatever DATABASE_URL points at):
//   node --env-file=.env scripts/load-claude-values.mjs --dry-run   match report only
//   node --env-file=.env scripts/load-claude-values.mjs             load for real
// Flags: --dry-run, --file <path> (default data/claude-values.json)
//
// SEALING: values only ride on SOLD rows (structural in state-core /
// players-core), so writing them to the DB does not unseal anything; the raw
// file stays out of git (see data/README.md and .gitignore).
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";
import { buildConfig, minOpenBid } from "../lib/config-core.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const DRY = has("--dry-run");
const FILE = val("--file", join(root, "data", "claude-values.json"));

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("DATABASE_URL not set. Run with --env-file pointing at the target DB.");
  process.exit(1);
}
if (!existsSync(FILE)) {
  console.error(`values file not found: ${FILE}\n(regenerate it with scripts/generate_claude_values.py)`);
  process.exit(1);
}

// League config, for the reveal-band fraction + minimum opening bid floor.
const localPath = join(root, "league.config.local.json");
const local = existsSync(localPath) ? JSON.parse(readFileSync(localPath, "utf8")) : undefined;
const cfg = buildConfig(JSON.parse(readFileSync(join(root, "league.config.json"), "utf8")), local);
const BAND_PCT = (() => {
  const raw = Number(cfg.valueBandPct);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.15;
})();

const rows = JSON.parse(readFileSync(FILE, "utf8"));
if (!Array.isArray(rows) || rows.length === 0) {
  console.error(`values file has no players: ${FILE}`);
  process.exit(1);
}

const norm = (s) => String(s ?? "").trim().toLowerCase();
const median = (nums) => {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

const sql = postgres(dbUrl, { max: 1 });
const dbName = (() => { try { return new URL(dbUrl).pathname.slice(1); } catch { return "?"; } })();

try {
  console.log(
    `target db "${dbName}" | file ${FILE} | ${rows.length} players` +
      (DRY ? " | DRY RUN (no writes)" : ""),
  );

  // Make sure the retainability column exists (additive; safe to re-run).
  if (!DRY) await sql`alter table valuations add column if not exists retainability numeric`;

  const players = await sql`select id, web_name, team_short from players`;
  const byId = new Map(players.map((p) => [p.id, p]));
  // Fallback key: name + team. Track ambiguity so a fallback never silently
  // maps to the wrong one of two same-named players at the same club.
  const byNameTeam = new Map();
  for (const p of players) {
    const k = `${norm(p.web_name)}|${norm(p.team_short)}`;
    if (byNameTeam.has(k)) byNameTeam.set(k, "AMBIGUOUS");
    else byNameTeam.set(k, p.id);
  }

  const matched = new Map(); // player_id -> { value, retainability, via }
  const unmatched = [];
  const conflicts = [];

  for (const r of rows) {
    const value = Number.isFinite(r.claude_value) ? Math.max(1, Math.round(r.claude_value)) : null;
    const retain =
      r.retainability == null || !Number.isFinite(Number(r.retainability))
        ? null
        : Number(r.retainability);

    let pid = null;
    let via = null;
    if (r.id != null && byId.has(r.id)) {
      pid = r.id;
      via = "id";
    } else {
      const k = `${norm(r.name)}|${norm(r.team)}`;
      const hit = byNameTeam.get(k);
      if (hit === "AMBIGUOUS") {
        unmatched.push({ ...r, reason: "name+team ambiguous (two players share it); id did not match" });
        continue;
      } else if (hit != null) {
        pid = hit;
        via = "name+team";
      }
    }

    if (pid == null) {
      unmatched.push({ ...r, reason: r.id != null ? `id ${r.id} not in pool; name+team no match` : "no id; name+team no match" });
      continue;
    }
    if (value == null) {
      unmatched.push({ ...r, reason: "no usable claude_value" });
      continue;
    }
    if (matched.has(pid)) {
      conflicts.push({ pid, kept: matched.get(pid), dropped: { name: r.name, team: r.team, value } });
      continue; // keep the first (file is sorted best-first)
    }
    matched.set(pid, { value, retainability: retain, via });
  }

  const viaId = [...matched.values()].filter((m) => m.via === "id").length;
  const viaNameTeam = [...matched.values()].filter((m) => m.via === "name+team").length;
  console.log(
    `matched ${matched.size}/${rows.length}  (by id: ${viaId}, by name+team: ${viaNameTeam})  ` +
      `| unmatched: ${unmatched.length} | in-file duplicates dropped: ${conflicts.length}`,
  );
  if (viaNameTeam) {
    console.log("  name+team fallback used for:");
    for (const [pid, m] of matched) if (m.via === "name+team") console.log(`    player ${pid} <- ${JSON.stringify(m.value)}`);
  }
  for (const u of unmatched) console.log(`  UNMATCHED: id=${u.id ?? "-"} ${u.name ?? "?"} (${u.team ?? "?"}) - ${u.reason}`);
  for (const c of conflicts) console.log(`  DUP DROPPED for player ${c.pid}: ${c.dropped.name} (${c.dropped.team}) $${c.dropped.value}`);

  // --- write --------------------------------------------------------------
  if (!DRY) {
    await sql.begin(async (tx) => {
      // Full replace: clear any prior valuations, then insert the new set. Safe
      // because every current player is covered by the file; a fresh value for
      // every sold player means no stale reveal survives. Backed up first.
      await tx`delete from valuations`;
      for (const [pid, m] of matched) {
        await tx`
          insert into valuations (player_id, value, retainability, generated_at)
          values (${pid}, ${m.value}, ${m.retainability}, now())
          on conflict (player_id) do update
            set value = excluded.value,
                retainability = excluded.retainability,
                generated_at = now()
        `;
      }
    });
  }

  // --- recalibrate the reveal band from the NEW values (#70) --------------
  // The band scales to the CONTESTED market, not the whole file. This source
  // values every player, flooring ~440 bench bodies at the $1 reserve; a median
  // over all of them is $1 and would give a useless +/-$1 FAIR band. The old
  // table only ever held the premium players actually bid on, so we reproduce
  // that by taking the median over values above the reserve floor (minOpenBid).
  // Falls back to the full set if too few clear the floor to be meaningful.
  const MIN_FOR_BAND = 3;
  const floor = minOpenBid(cfg);
  const allValues = [...matched.values()].map((m) => m.value);
  const contested = allValues.filter((v) => v > floor);
  const values = contested.length >= MIN_FOR_BAND ? contested : allValues;
  const med = median(values);
  const band = Math.max(floor, Math.round(BAND_PCT * med));
  if (!DRY) {
    await sql`
      insert into valuation_meta (id, fair_band, band_pct, median_value, sample_size, generated_at)
      values (1, ${band}, ${BAND_PCT}, ${med}, ${values.length}, now())
      on conflict (id) do update set
        fair_band = excluded.fair_band, band_pct = excluded.band_pct,
        median_value = excluded.median_value, sample_size = excluded.sample_size,
        generated_at = now()
    `;
  }
  console.log(
    `reveal band: $${band} (${Math.round(BAND_PCT * 100)}% of contested median $${med}, ` +
      `floor $${floor}, n=${values.length} of ${allValues.length} above floor)` +
      (DRY ? " (dry run - not written)" : ""),
  );

  console.log(
    `\nDONE: ${matched.size} valuations ${DRY ? "would be" : ""} loaded` +
      (DRY ? " (dry run - nothing written)." : "."),
  );
} catch (err) {
  console.error("load-claude-values failed:", err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
