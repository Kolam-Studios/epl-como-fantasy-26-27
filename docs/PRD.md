# EPL Como Fantasy 26/27 — Product Requirements

> Status: DRAFT for review. Public repo — shared league tooling only, nothing private to any manager.
> **v1 target: the live auction on Aug 2, 2026 (in person).** Season scoring is deferred (see Future).

## Problem

The Como league runs a live auction draft each season, historically tracked in an ad-hoc Google Sheet. There's no purpose-built tool to run the live auction with budget/roster validation and a shared in-room view. We're building that, config-driven so it reruns every season and sport. The season-long points tracker is a later phase, not part of the Aug 2 v1.

## Users

- **Commissioner** — one operator who runs the draft from a control panel: nominates the lot, enters the winning manager + sold price. Token-gated.
- **Managers** — in the room. Watch the live board (the **projector/big-screen** view and/or their own phone): current lot, every manager's spend / remaining / slots filled.

## Scope — v1 (auction only, in person, Aug 2)

### Live draft board
- Commissioner nominates a player and records `winner + sold price`.
- App validates each sale against league config: budget remaining, position-slot availability, exclusive ownership (no double-owning a player).
- **Projector view** — a read-only big-screen board for the room, plus the commissioner's entry panel (the admin / big-screen role split). All views refresh by polling (~2s). Bidding stays verbal in the room; the app is the system of record, not the auctioneer.
- **Undo** — commissioner can reverse a mis-entered sale.
- Player pool sourced from the FPL API (`bootstrap-static`, 4 element types).

## Future (out of scope for the Aug 2 v1)

- **Season tracker** — sum each owned player's official FPL gameweek points per manager → standings. Rosters carry forward from the draft. Scoring model (all-15 vs weekly XI + captain) to be settled when this phase starts. Schema reserves `gw_scores`.
- **Rebid rounds** — the league runs 3–4 mid-season blind-bid rounds; schema reserves `picks.round` and `rebidRounds` config.

## Non-goals (v1)

- **No contested real-time bidding** in software. Commissioner enters results; no bid timers, locks, or auto-increment.
- **No season scoring** in v1 (deferred — see Future).
- **No private projections / valuations.** Any manager's edge model is out of scope for this shared repo.
- **No auth beyond the commissioner token.** The board view is open to anyone with the link.

## Format rules (config-driven)

Seeded from 25/26 actuals; all live in `league.config.json`:

| Rule | Default | Notes |
|---|---|---|
| Managers | 7 | count derives from the array length |
| Budget | $2000 each | |
| Squad | 2 GK / 5 DEF / 5 MID / 3 FWD (15) | |
| Ownership | exclusive (`multipick: false`) | one manager per player |
| Bid floor | $1 | no fixed increment |
| Scoring | FPL points (`scoringSource: "fpl"`) | reserved for the deferred tracker; unused in v1 |

## Acceptance criteria (v1)

- [ ] `npm run db:setup && npm run ingest` produces a populated player pool (GK/DEF/MID/FWD only) and seeded managers against a fresh Postgres.
- [ ] Commissioner can record a sale; an invalid sale (over budget, no slot, already owned, below floor) is rejected with a clear error.
- [ ] Two browsers (commissioner + projector view): a sale entered on the panel appears on the board within ~2s.
- [ ] Budget / slot / exclusivity invariants hold after every sale; concurrent sales can't oversell (live race test, not just unit asserts).
- [ ] Undo reverses a sale and restores budget + slot.
- [ ] Config change (e.g. 8 managers, different squad shape) is honoured with no code change.
- [ ] **Port walk:** the Vercel deploy path in `docs/PORTING.md` completes with no code change (proves the portability claim, not just asserts it).
- [ ] **Browser smoke test:** a human opens the deployed URL and confirms the board renders and updates. (Server 200s are not sufficient.)

## Deployment

- **Reference:** self-hosted (Docker) against Postgres (container or Neon).
- **Port target:** Vercel + hosted Postgres. See `docs/HANDOFF.md` and `docs/PORTING.md`.
