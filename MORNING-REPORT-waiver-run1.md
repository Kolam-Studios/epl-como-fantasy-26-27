# Morning report: waiver build, run 1 (overnight 2026-08-04)

Mission: build the waiver era per docs/DESIGN-WAIVERS.md (the ratified spec of record). All seven stages shipped, battery green at every commit, engine adversarially reviewed. Nothing touched production: every test and browser check ran against throwaway scratch databases; no deploys, no env changes.

## What shipped (one commit per stage, all pushed to main)

| Stage | Commit | What |
|---|---|---|
| 1. Periods + archiving foundation | c86b9a0 | periods + period_snapshots tables (additive), lifecycle locked -> open -> resolving -> closed with audit, app_state.current_period_id, period stamps on sales/trades, config-driven season calendar, idempotent Bid 1 backfill script (scripts/backfill-period1.mjs), /api/state exposes periods |
| 2. Phase navigation (mockup A) | 0f21e6c | two-level phase rail + sub-tabs with live/locked/archived states, /phase/[seq] routes, root resolves to the current phase, /board stable TV alias, swipeable phone rail, /api/periods + /api/period/[seq] |
| 3. Shared surfaces (mockups F, E) | 0b4f3fc | one SquadCard renders ALL 15 players across desktop/phone/TV (zero-width scale guard kept; TOP_N cap gone), shared ledger filter model (status/position/club popover with accent-insensitive search, pills, live count, sortable price/value) on desktop AND phone |
| 4. Waiver form + tokens (mockup B) | 9cc692d | manager_tokens hashed at rest (case-insensitive words, never in payloads or logs), the four-step form, full server-side validation per spec 3B, waiver_submissions/drops/bids (every version kept, latest before cutoff wins), X-Manager-Token write path separate from COMMISSIONER_TOKEN, sat-out managers excluded |
| 5. THE ENGINE (spec section 4) | 5a4d190 | the resolution walk with the spec 4.3 worked example as a permanent fixture, one-transaction apply (results, outcomes, sales per win, drops + released flags, audit, close, snapshot, open next, version bump), commissioner dry-run, the blackout (trades AND corrections AND manual sales pause from cutoff to publication), the released-sales sweep across every read |
| 6. Token history + archives (mockups C, D) | 1d8a5c5 | /waiver/history token lookup (never confirms token existence), archived-period record led by the transfer record + published seed, frozen squads/ledger/trades/charts panes, per-period Trades sub-tab, console blackout banner + resolve panel (dry run / apply) |
| 7. Console additions (mockup H) | aeb25b5 | build-queue button, sit-out toggles (rotation, form dropdown and engine all respect the flag), accent-insensitive nomination search, recent-lots list with per-sale void |

## Battery status

GREEN. The integrated battery grew from 17 to 23 suites; the final run (after the last commit) passes all 23 (one documented transient retry on the trade suite, a cloud-Postgres blip, passed deterministically on retry). New suites: periods (36 checks), waiver form (43), waiver engine pure fixture (37, reproduces the spec's worked example outcome-for-outcome), waiver resolution integration (51: dry-run purity, blackout, transactionality, re-signing dropped players, double-resolution race), text folding, managers/sit-out.

Browser verification (scratch dev server, per CLAUDE.md): full form E2E submit and resubmit prefill; a real resolution propagated to TWO tabs via polling (squads swapped, budgets sunk, archive frozen, rail moved to the next period); ledger filters; archived panes; token history lookup.

## The adversarial review (engine gate)

An adversarial subagent attacked the transaction as CLAUDE.md demands. It confirmed two of my fixes and found one real bug I had missed:

1. CONFIRMED FIXED: post-write failures inside the resolve transaction originally returned rejections (which would COMMIT partial state); they now throw and roll back whole. The reviewer independently forced a snapshot failure and verified nothing committed.
2. FOUND AND FIXED: the tie-break comparator was intransitive - the winner of a contested equal-amount tie could flip depending on which manager's form loaded first. The walk order is now built structurally (equal-amount bands -> per-player groups ordered by proportional purse -> groups ordered by form-order edges with seeded cycle-breaking), regression-tested from both input orders.
3. FOUND AND FIXED: the blackout only covered trades; a sale void/edit or manual sale between cutoff and resolve could silently change start-of-round budgets. Corrections (undo/edit/void) and recordSale now pause during the blackout too.

## What did not ship, and why

- COMO history page (mockup G): a collaborator's overnight commit (507de0a) added the full historical dataset, but it carries real first names, and the repo rule to date is roles only. Building the page would put those names on a rendered public surface; that is an owner policy call, not mine. Stub remains; issue #80.
- No-bid lot REOPEN (half of mockup H item 4): needs a new lot action that restores a passed player without disturbing the queue cursor. Issue #82.
- Reveal surface for waiver results: format is deliberately an open owner decision; the engine output (seed + ordered outcome log, frozen in the snapshot) is already shaped for a bid-by-bid replay. Issue #78.

## Decisions I made alone (flag anything to change)

1. Exclusive ownership evolved: a dropped player keeps their old sales row (spend stays sunk) marked released, and can be re-signed later with a NEW row. UNIQUE(player_id) is replaced by a partial unique index on ACTIVE sales - the backstop is preserved, strengthened to "one active owner per player". The migration is ordered (add column, build stronger index, then drop the old constraint) so there is never a window without a backstop.
2. Season calendar lives in league.config.json ("periods"), seeded idempotently; statuses are runtime-only. Bid 2 ships locked with cutoff null (date TBD).
3. Cutoffs stored as +10:00 fixed offsets per the spec's "5:00pm AEST" wording; four of the six waiver cutoffs fall in AEDT months - flagged as issue #83 rather than silently choosing.
4. New sales/trades stamp period_id AND stage = the period label; the auction's rows keep their original 'auction-1' stage string with period_id backfilled, so the historical record is untouched.
5. Waiver submissions do not bump the public state version (submissions are invisible by design until resolution).
6. Resolve has an audited `force` flag for early resolution (rehearsals aside, the dry run needs no force and writes nothing).
7. The console got a minimal resolve panel (dry run + confirm-gated apply) even though mockup H deferred console work: the Commissioners need a button, not curl, on 26 Sep.
8. The projector squads variant is selected by /squads?tv=1 (issue #81 to confirm the mechanism).
9. docs/DESIGN-WAIVERS.md committed with its status flipped to RATIFIED, as the spec of record.

## Owner-gated checklist (in order)

1. PRODUCTION SNAPSHOT FIRST: take the database snapshot of the auction record BEFORE deploying the waiver schema (it swaps the sales uniqueness constraint; data is untouched, but the record of 2 Aug deserves a belt-and-braces copy).
2. Deploy main to Vercel, then run `node --env-file=.env scripts/db-setup.mjs` and `node --env-file=.env scripts/backfill-period1.mjs` against production (idempotent; stamps the auction rows, freezes the Bid 1 archive, opens Waiver 1, points the site at it).
3. COMMISSIONER_TOKEN rotation: still on the pre-waiver list; not rotated tonight (owner action).
4. Assign real manager tokens: `node --env-file=.env scripts/set-manager-token.mjs --slot N --token WORD` per manager; words chosen offline, never in the repo.
5. Sit-out: tick the sat-out manager in the console once deployed (their wallet row stays as the record).
6. Bid 2 date: one config entry when the January poll lands (issue in the calendar until then).
7. Reveal format decision (issue #78) and the AEST/AEDT call (issue #83).
8. The name-policy question on the public history data (issue #80) - also note the collaborator's commit 507de0a itself put real first names in the public repo; rewriting that history is your call, not mine.
9. Dress rehearsal before 26 Sep: console dry-run resolve against a scratch copy; the dry run writes nothing and prints the full walk.

## Follow-up issues filed tonight (all scrubbed)

#77 docs refresh, #78 reveal format, #79 Bid 2 period-scoped lot layer, #80 history page name policy, #81 projector variant, #82 no-bid reopen, #83 AEST/AEDT.
