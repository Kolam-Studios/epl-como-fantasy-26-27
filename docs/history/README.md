# EPL Como history

Consolidated record of every EPL Como auction with a surviving sheet, one row per winning bid, scored against each player's actual final-season FPL points. Built by `build_history.py` from the original league spreadsheets.

## Files

- `epl-como-buys.csv` - every winning bid across all recorded seasons
- `epl-como-managers.csv` - per season, per manager rollup
- `epl-como-seasons.csv` - season metadata: format, completeness, what was and was not recorded

## Columns (epl-como-buys.csv)

- `season` - EPL season, e.g. 2023-24
- `manager` - winning bidder
- `phase` - how the player was won: `auction` (the opening auction), `rebid` (an in-season rebid round), `blind` (sealed bids), `live` (open-outcry), `settled` (a squad table taken after the season's bid rounds, not a bid log)
- `player_raw` - the name exactly as written in the source sheet
- `player` - canonical FPL web name after matching (alias map handles sheet misspellings)
- `pos`, `team` - position and club from the FPL dataset
- `price` - winning bid in league dollars (budgets differ per season, see seasons file); blank where the sheet recorded a winner but no price
- `fpl_points`, `fpl_minutes` - the player's actual full-season FPL totals for that season; blank for 2026-27 (not yet played)
- `matched` - whether the sheet name resolved to an FPL player (all rows currently `yes`, `n/a` for 2026-27 app rows which carry their own FPL codes)

## Points sources

- 2016-17 through 2021-22 and 2023-24: vaastav/Fantasy-Premier-League `players_raw.csv` for the season
- 2025-26: FPL bootstrap snapshot taken 2026-07-31, after season end
- 2026-27: no points yet; prices from the auction app export of 2026-08-02

## Caveats

### What each season actually recorded

- Full bid logs survive for 17/18 (auction plus one rebid), 18/19 (auction, four rebids, one bargain-bin blind round), 20/21 (auction, one blind bargain round, two rebids), 23/24 (live auction plus blind bids), 25/26 and 26/27.
- 16/17, 19/20 and 21/22 are squad-table reconstructions only. The bid-by-bid record for those seasons is gone; each row is a player and a price read off the final squad table, so the phase is `settled` and nothing distinguishes an opening-auction buy from a later pickup.
- 18/19 rebid 1 and rebid 2 name the winning bidder but leave the price cell empty on most rows, so `price` is blank there. Those rows are in the buys file for the ownership record; they contribute nothing to spend.
- 18/19 `settled` rows come from the Rebid Teams tab, whose Cost column is rebid spend only and is blank for players retained from the auction. The 18/19 manager rollup therefore measures rebid outlay, not season-long outlay.
- 20/21 has no settled squad table. The rollup is the auction plus the kept bargain-round wins, which gives 15 players each except Robbie, who won 9 and took no bargain-round player.
- 16/17 squads carry 18 slots rather than 15, and the season's costs do not reconcile to the sheet's own TOTAL SPENT row, which is stale against in-season transfers. Use 16/17 spend as indicative only.
- 21/22 rows are the settled squads after the season's bid rounds, not the opening auction alone.
- 23/24 rosters are incomplete in the source sheet: managers hold 6 to 14 recorded players, only Trent reached 15 (then dropped Berge, an uncontested $5 blind win, so 14 kept and Berge is excluded here). The January rebid was not run. Spend totals reconcile to the sheet's own cashflow figures.
### Standings

- Only 16/17, 17/18 and 25/26 have a recorded final ladder. 16/17 finished Robbie 1856, Varun 1772, Arj 1713, Lakshman 1658, Margit 1484, Ambrose 1469, Milo 1307. 17/18 was scored in three sessions and finished Lakshman 1717, Milo 1708, Robbie 1649, Ambrose 1582, Dinesh 1496, Farhaan 1386.
- 18/19, 19/20, 20/21, 21/22 and 23/24 have no standings of any kind in their sheets.
- `squad_points` and `best_xi_points` measure draft quality, not league finish. Three external checks are available. 16/17: the method ranks Robbie then Varun, matching the actual top two. 17/18: it ranks Lakshman first, matching, then Ambrose where the actual runner-up was Milo. 25/26: it ranks Dom then Mayoori against an actual finish of Mayoori first, Dom second.
### Method

- `best_xi_points` is a 1 GK / 3 DEF / 3 MID / 1 FWD minimum plus best three remaining outfielders, computed on full-season totals; blank where a manager has fewer than 11 scored players.
- `epl-como-managers.csv` counts each season from its most-settled phase only, so a manager is never double-counted: `settled` for 16/17, 17/18, 18/19, 19/20 and 21/22; `auction` plus `blind` for 20/21; every recorded phase for 23/24, 25/26 and 26/27.
- Manager names are kept as each season's own sheet writes them, so cross-season identity is not resolved here (19/20 "Olli" and 18/19 "Oliver" are recorded separately, as are 18/19 "Alex" and 20/21 "Alex Patton").
- 2022-23 and 2024-25 had no EPL auction (the 22/23 sheet is FPL data only; 24/25 ran BBL instead).
