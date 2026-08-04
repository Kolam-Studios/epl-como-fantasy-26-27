#!/usr/bin/env node
// Builds app/history/history-data.json from docs/history/*.csv (mockup G,
// docs/DESIGN-WAIVERS.md section 3G). Re-runnable, no DB, no new packages.
// tsconfig.json already has resolveJsonModule: true, so the page imports
// this JSON file directly (bundled at build time, no fs at runtime).
//
// Usage: node scripts/build-history-data.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const HISTORY_DIR = path.join(ROOT, "docs", "history");
const OUT_FILE = path.join(ROOT, "app", "history", "history-data.json");

// ---- tiny CSV parser: handles quoted fields with embedded commas and
// doubled-quote escapes ("" -> "). Good enough for these three files; no
// multi-line quoted fields are present in the source data. ----
function parseCsv(text) {
  const rows = [];
  const lines = text.split(/\r\n|\n/).filter((l) => l.length > 0);
  for (const line of lines) {
    const fields = [];
    let i = 0;
    let field = "";
    let inQuotes = false;
    while (i < line.length) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          inQuotes = false;
          i += 1;
          continue;
        }
        field += ch;
        i += 1;
        continue;
      }
      if (ch === '"') {
        inQuotes = true;
        i += 1;
        continue;
      }
      if (ch === ",") {
        fields.push(field);
        field = "";
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
    }
    fields.push(field);
    rows.push(fields);
  }
  const header = rows[0];
  return rows.slice(1).map((row) => {
    const obj = {};
    header.forEach((key, idx) => {
      obj[key] = row[idx] === undefined ? "" : row[idx];
    });
    return obj;
  });
}

function toNumOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function toStrOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

// Parses the seasons.csv "champion" cell into champion/runnerUp/note.
//   ""                              -> in-progress season, nothing decided yet
//   "unknown (no ladder recorded)"  -> no champion known, note kept
//   "Robbie (Varun 2nd)"            -> champion Robbie, runner-up Varun
//   "Name"                          -> champion Name, no runner-up recorded
function parseChampion(raw) {
  const s = (raw || "").trim();
  if (s === "") {
    return { champion: null, runnerUp: null, championNote: null, inProgress: true };
  }
  const m = s.match(/^(.*?)\s*\((.*?)\)\s*$/);
  if (!m) {
    return { champion: s, runnerUp: null, championNote: null, inProgress: false };
  }
  const head = m[1].trim();
  const inner = m[2].trim();
  if (/^unknown$/i.test(head)) {
    return { champion: null, runnerUp: null, championNote: inner, inProgress: false };
  }
  const runnerMatch = inner.match(/^(.*?)\s+2nd$/i);
  if (runnerMatch) {
    return { champion: head, runnerUp: runnerMatch[1].trim(), championNote: null, inProgress: false };
  }
  // parenthetical present but not a "X 2nd" shape: keep as a note, no runner-up
  return { champion: head, runnerUp: null, championNote: inner, inProgress: false };
}

function buildSeasonEntry(seasonRow, managerRows, buyRows) {
  const managersCount = toNumOrNull(seasonRow.managers);
  const played = managersCount !== null;

  const parsedChampion = parseChampion(seasonRow.champion);
  const { champion, runnerUp, championNote } = parsedChampion;
  // "in progress" only means something for a season that actually ran; the
  // "no auction run" rows have an empty champion cell too but are not a
  // season in progress, they are not a season at all.
  const inProgress = played && parsedChampion.inProgress;

  const perManager = managerRows
    .map((m) => ({
      manager: m.manager,
      players: toNumOrNull(m.players),
      spend: toNumOrNull(m.spend),
      squadPoints: toNumOrNull(m.squad_points),
      bestXiPoints: toNumOrNull(m.best_xi_points),
    }))
    .sort((a, b) => {
      if (a.squadPoints === null && b.squadPoints === null) return 0;
      if (a.squadPoints === null) return 1;
      if (b.squadPoints === null) return -1;
      return b.squadPoints - a.squadPoints;
    });

  let topBuy = null;
  let totalSpend = 0;
  let bestValueBuy = null;
  let bestValueRatio = -Infinity;

  for (const b of buyRows) {
    const price = toNumOrNull(b.price);
    if (price !== null) {
      totalSpend += price;
      if (!topBuy || price > topBuy.price) {
        topBuy = { player: b.player || b.player_raw, manager: b.manager, price };
      }
      const fplPoints = toNumOrNull(b.fpl_points);
      if (price >= 50 && fplPoints !== null) {
        const ratio = fplPoints / price;
        if (ratio > bestValueRatio) {
          bestValueRatio = ratio;
          bestValueBuy = { player: b.player || b.player_raw, manager: b.manager, price, fplPoints };
        }
      }
    }
  }

  return {
    season: seasonRow.season,
    managers: managersCount,
    budget: toNumOrNull(seasonRow.budget_per_manager),
    squadSize: toNumOrNull(seasonRow.squad_size),
    recordNote: toStrOrNull(seasonRow.record),
    source: toStrOrNull(seasonRow.source),
    champion,
    runnerUp,
    championNote,
    inProgress,
    played,
    perManager,
    topBuy,
    bestValueBuy,
    totalSpend: buyRows.length > 0 ? totalSpend : null,
    buyCount: buyRows.length,
  };
}

function main() {
  const seasonsCsv = readFileSync(path.join(HISTORY_DIR, "epl-como-seasons.csv"), "utf8");
  const managersCsv = readFileSync(path.join(HISTORY_DIR, "epl-como-managers.csv"), "utf8");
  const buysCsv = readFileSync(path.join(HISTORY_DIR, "epl-como-buys.csv"), "utf8");

  const seasons = parseCsv(seasonsCsv);
  const managers = parseCsv(managersCsv);
  const buys = parseCsv(buysCsv);

  const entries = seasons.map((seasonRow) => {
    const season = seasonRow.season;
    const managerRows = managers.filter((m) => m.season === season);
    const buyRows = buys.filter((b) => b.season === season);
    return buildSeasonEntry(seasonRow, managerRows, buyRows);
  });

  // newest first
  entries.sort((a, b) => (a.season < b.season ? 1 : a.season > b.season ? -1 : 0));

  writeFileSync(OUT_FILE, JSON.stringify(entries, null, 2) + "\n", "utf8");

  console.log(`Wrote ${entries.length} seasons to ${path.relative(ROOT, OUT_FILE)}`);
}

main();
