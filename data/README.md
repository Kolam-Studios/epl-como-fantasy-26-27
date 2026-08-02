# data/

Sealed, private auction data. **Contents are gitignored** (`/data/*.json`,
`/data/*.csv`) on purpose: this is a public repo and the Claude auction values
must never land in git (same rule as sealed valuations in the DB - see
`CLAUDE.md`). Only this README is tracked.

## `claude-values.json`

Retention-adjusted fair auction values ("Claude values") for every FPL player,
one object per player:

| field | example | notes |
|---|---|---|
| `id` | 411 | FPL element id (join key to `players.id`) |
| `name` | `Haaland` | FPL web_name |
| `full_name` | `Erling Haaland` | |
| `team` | `MCI` | club short name |
| `pos` | `FWD` | GK/DEF/MID/FWD |
| `fpl_price` | 15.5 | FPL game price (GBPm) |
| `selected_pct` | 75.2 | FPL global ownership |
| `status` | `a` | a/d/i/s/u (available/doubt/injured/susp/left) |
| `news` | `...` | injury text, when status != a |
| `claude_value` | 1347 | fair auction value in league $ |
| `retainability` | 0.62-1.00 | share of value that survives the February retention rule at this price |

The values are **retention-adjusted**: an August buy is first-half points plus
an *option* to retain for the second half at the same price, and that option
decays with price. Premiums are therefore valued lower than a raw
points-per-dollar model (Haaland $1,347, Bruno $1,008), so they can read OVERPAY
at market prices - that is the February retention tax, working as intended.

## Regenerating (auction morning)

`scripts/generate_claude_values.py` pulls the live FPL API and rewrites this
file so prices / injuries / ownership are fresh:

```bash
pip install requests
cd data && python ../scripts/generate_claude_values.py   # writes claude-values.json (+ .csv) here
```

## Loading into the auction DB

`scripts/load-claude-values.mjs` reads this file and upserts the values +
retainability into the `valuations` table (matching by FPL id, then by
name+team), and recalibrates the STEAL/FAIR/OVERPAY reveal band:

```bash
node --env-file=.env scripts/load-claude-values.mjs --dry-run   # match report, no writes
node --env-file=.env scripts/load-claude-values.mjs             # load for real
```
