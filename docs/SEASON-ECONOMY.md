# Season economy - the wallet model (v2 proposal)

> Status: DRAFT, 9 Jul 2026. Proposed by the league owner; amounts and waiver
> mechanics not yet ratified by the group. **Nothing here changes v1 or the
> Aug 2 auction night.** This doc exists so v2 is designed against a written
> spec and so v1 code leaves the right seams open.

## The idea in one line

Each manager has ONE wallet for the whole season. Money unspent at any stage
rolls forward into the next stage; cash injections top it up at fixed points.

## The four spending moments

| Stage | When | Money in | Money out | Balance after |
|---|---|---|---|---|
| Auction one | Aug 2 | A1 = $3,000 starting budget | X1 auction spend | Y1 = A1 - X1 |
| Waiver window one | Aug - Jan | A2 = $500 (TBC) injection | X2 waiver purchases | Y2 = Y1 + A2 - X2 |
| Auction two (rebid) | early Feb, after the real transfer window closes | A3 = $2,000 injection | X3 rebid spend | Y3 = Y2 + A3 - X3 |
| Waiver window two | Feb - May | A4 = $500 (TBC) injection | X4 waiver purchases | season ends |

All amounts are league config, never code.

## Retention at the rebid (the deliberate squeeze)

At auction two a manager may retain any player they own **at the price they
paid in August**. Everyone not retained goes back into the pool.

The February injection is $2,000, not $3,000. Same retention price, smaller
pot: a $1,000 August star cost 33% of the August budget but eats 50% of the
February base pot. Effect: bargain buys and saved money appreciate; heavy
spending on one star is taxed at the rebid. This is intended.

## Waivers (mechanics TBD)

Between auctions, managers buy waivers to swap out injured or underperforming
players. Waiver spending draws on the same wallet, so it directly reduces
February firepower. Pricing, contested-claim priority, and what happens to a
dropped player's salary are all open questions for the group.

## Open questions (decide before v2 build)

1. Injection amounts: $500 / $2,000 / $500 are working numbers; only the
   $2,000 rebid injection is considered settled.
2. Waiver pricing model: flat fee, tier-based fee, or mini-auction?
3. Contested waiver claims: priority order (reverse standings? first come?).
4. Dropped player salary: gone entirely, or partial refund?
5. Retention limits: cap on how many players can be retained? Deadline?
6. Rebid date: exact date in early February.
7. Carry-over cap: may a manager bank heavily in August to dominate February,
   or should carry-over be capped?
8. Roster shape between auctions: does 2 GK / 5 DEF / 5 MID / 3 FWD hold
   through waivers?

## Consequences for the build

**v1 (Aug 2) is unchanged mechanically.** Two cheap adjustments worth making
during the current runs:

1. **The recap must headline leftover money (Y1).** It is no longer trivia;
   it is next February's war chest. The end-of-night archive must record it
   per manager as a number of record.
2. **Tag money events with a stage.** Sales, trades, and future waiver and
   injection rows should carry a stage or event identifier (auction-1,
   waivers-1, auction-2, waivers-2) so February does not have to untangle
   August's rows. Adding the column early is cheap; retrofitting is not.

**v2 additions this model implies** (all fit the existing derive-from-ledger
rule: balances are never stored, always derived from the transaction log):

- New transaction types in the ledger: injection, waiver purchase, retention.
- Config gains a stages array: dates, injection amounts, waiver rules.
- Retention flow at rebid setup: pick keepers at August prices, releases
  return to the pool, budgets derive as Y2 + A3 - retained salaries.
- The max-bid reserve rule needs a February variant (open slots against the
  rebid pot, retained players excluded).
- The board's budget panel becomes stage-aware (shows current wallet, not
  "remaining of $3,000").
