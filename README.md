# EPL Como Fantasy — 26/27

Self-hosted **live auction-draft** tool for the Como fantasy league. Config-driven framework: reruns each season/sport by swapping `league.config.json`.

> **v1 = the auction, in person, Aug 2 2026.** Season scoring is a later phase.

**Status (2026-07-07):** spec phase. No app runtime yet; the work queue is the [GitHub issues](https://github.com/miloli-git/epl-como-fantasy-26-27/issues) (start at #9, the build plan). Agents: read `CLAUDE.md` first, including the human confirmation gates.

## What it is

- **v1 — Live auction board.** Commissioner nominates a player and enters the winning manager + sold price. The room watches a live, read-only **projector/big-screen** board (current lot, who owns what, budget remaining, slots filled) that also serves to each manager's phone. Bidding is verbal in the room; the app is the system of record. Budget / roster-slot / exclusive-ownership validation on every sale, plus undo.
- **Future — Season tracker.** Sum each owned player's official FPL gameweek points per manager → standings. Schema reserves room; not built yet.
- **Future — Rebid rounds.** Mid-season blind-bid rounds. Reserved, not built.

## Stack

- **Next.js** (App Router, TypeScript) — runs on Vercel natively and self-hosts in Docker identically.
- **Postgres** (Neon / Supabase free tier, or self-hosted) — single `DATABASE_URL`.
- **Live updates by polling** `/api/state` (~2s). No WebSocket infra; ports anywhere unchanged.
- **FPL public API** for the player pool. Ingest references the `fpl-api` (TS, MIT) field shapes; no framework adopted.

## Deploy targets

- **Reference:** self-hosted via Docker, pointed at Postgres (container or Neon).
- **Port:** `vercel deploy` against the same schema. No WebSocket server and no local SQLite file, so the port is a deploy-target swap — see `docs/PORTING.md` and `docs/HANDOFF.md`.

## Quick start

```bash
cp .env.example .env.local          # set DATABASE_URL + COMMISSIONER_TOKEN
npm install
npm run db:setup                    # apply db/schema.sql, seed managers
npm run ingest                      # pull FPL player pool -> players table
npm run dev                         # http://localhost:3000
```

## Repo map

| Path | What |
|---|---|
| `league.config.json` | the reuse layer — managers, budget, squad (placeholder names; real roster in gitignored `league.config.local.json`) |
| `db/schema.sql` | Postgres schema (managers, players, picks; `gw_scores` reserved) |
| `scripts/` | FPL ingest + db setup |
| `lib/` | db client, config loader |
| `app/` | Next.js app — auction board UI + API routes (built during v1) |
| `docs/PRD.md` | scope, phases, acceptance criteria |
| `docs/DATA-MODEL.md` | schema rationale, config seam, API surface |
| `docs/HANDOFF.md` · `docs/PORTING.md` | build-vs-port split and the Vercel port walk |
| `docs/DECISIONS-TO-CONFIRM.md` | open decisions tracker |
| `docs/PRIOR-ART.md` | external scan of comparable tools |
| `CLAUDE.md` | context for AI coding agents working this repo |

MIT licensed.
