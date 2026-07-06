# CLAUDE.md — agent context

Context for any AI coding agent (Claude Code / Cursor) working this repo.

## What this is

Config-driven **live auction-draft** tool for a private fantasy league. **v1 target: the auction, in person, Aug 2 2026.** Season scoring + rebids are deferred (see `docs/PRD.md` Future). **Public repo** at `github.com/miloli-git/epl-como-fantasy-26-27` — shared tooling only, no real names, no secrets, no private valuation models. Read `docs/PRD.md`, `docs/DATA-MODEL.md`, `docs/HANDOFF.md` before changing anything.

## Current state + where to start (2026-07-07)

- **No app runtime exists yet** (`app/` is not built). The repo is docs + scaffold (schema, config, ingest/setup scripts).
- **The work queue is the GitHub issues.** Read [#9 (v1 build plan, tracking)](https://github.com/miloli-git/epl-como-fantasy-26-27/issues/9) first; it sequences all work into sprints. Do not invent your own order.
- **Proceed in this order:** spec fixes in the docs first (#1 maxBid validation, #3 lot/pause/app_state contract, #6 undo contract, #7 doc drift), then the config loader (#2), then the Sprint 1 walking skeleton per #9. #4 (sale locking) and #5 (ingest guard + position snapshot) land with the endpoints/scripts they affect, not before.
- **Where docs conflict, `docs/DESIGN.md` is correct** (its max-bid rule is the confirmed league rule; see #1). Update the other docs to match it, not the reverse.
- Run the Vercel port walk (`docs/PORTING.md`) at the END of Sprint 1, not at the end of the project.

## Human confirmation gates

These are decisions for the human driving, not the agent. Stop and ask; never assume, guess, or build past them:

1. **Starting the app build at all.** No app scaffolding without an explicit go. Spec/doc fixes (#1, #3, #6, #7) are fine to do when asked; `app/` is not.
2. **Bidding model (#8).** Everything here assumes A (commissioner enters winner + price). If a request implies login bidding, bid timers, or realtime infra, stop and confirm: that decision voids the current plan.
3. **League facts:** the real roster (names go ONLY in gitignored `league.config.local.json`), pool-freeze date, commissioner identity, draft-night hosting. Never guess these and never commit them.
4. **Net-new scope:** in-auction trades, formation/pitch view, any AI/prediction overlay. All confirmed out of v1; confirm before touching.
5. **Anything the scrub gate flags** (see Hard rules). When in doubt about whether content is private, it is; ask.

## Stack

- Next.js (App Router, TypeScript), Postgres via `postgres` (postgres.js), live updates by polling `/api/state`.
- One `DATABASE_URL`. Runs self-hosted (Docker, `output: standalone`) and on Vercel from the same code.

## Hard rules

- **Exclusive ownership** is a DB constraint (`picks.player_id` unique). Don't bypass it.
- **No hardcoded league params.** Read from `league.config.json` (real roster overrides via gitignored `league.config.local.json`). Manager count and squad size are always derived from config.
- **Spend/remaining/slots are derived** from `picks` + config at read time. Never store them.
- **Commissioner-gated writes.** `POST/DELETE /api/draft` require `COMMISSIONER_TOKEN`. Reads are open.
- **No real names or secrets in commits.** `.env*` and `league.config.local.json` are gitignored — keep it that way.
- **Before any public push, run the scrub gate:** `git diff --staged` for real manager names / tokens / connection strings; confirm `.env*` and `league.config.local.json` are untracked; confirm no private valuation/projection content. No push if any hit.
- Portability is a requirement: no WebSocket server, no local SQLite, no custom Node server. If a change breaks the Vercel port, it's wrong (see `docs/HANDOFF.md`).

## Build order (when build is approved)

Sprint sequence lives in issue #9. In short: API routes (`state`, `lot`, `draft` incl. undo, `players`) → board UI (poll) → projector/big-screen view + commissioner panel → manager phone view. `/api/draft` (the no-oversell transaction, per issues #1 and #4) is correctness-critical: build it with an adversarial review pass. Deferred: season-score ingest + standings, rebid rounds.

## Verify

After any change: `npm run db:setup && npm run ingest` against a scratch DB, then open the board in a browser and confirm a recorded sale propagates to a second tab. Server 200s alone don't count.
