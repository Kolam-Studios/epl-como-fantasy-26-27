# Data Model

> Status: DRAFT for review. Canonical schema is `db/schema.sql`; this explains it.

## Config layer (the reuse seam)

`league.config.json` holds everything that varies by season/sport. The app derives manager count and squad size from it; nothing is hardcoded.

```json
{
  "season": "26/27", "sport": "epl",
  "managers": ["Manager 1", "..."],      // count = managers.length
  "budget": 2000,
  "squad": { "GK": 2, "DEF": 5, "MID": 5, "FWD": 3 },  // sum = squad size
  "bidFloor": 1, "increment": null,
  "multipick": false, "rebidRounds": 3,
  "scoringSource": "fpl"
}
```

Real manager names are NOT committed (public repo). The committed file uses placeholders; a gitignored `league.config.local.json` overrides with the real roster on the machine running the draft.

## Tables

```
managers   id, name(unique)
players    id(FPL element id) PK, name, team, position(GK|DEF|MID|FWD), value, tier, updated
picks      id, player_id→players(unique), manager_id→managers, price, round(default 1), created_at
gw_scores  player_id→players, gw, points        (Phase 2; PK = player_id+gw)
```

### Why these choices

- **`players.id` = FPL element id.** The FPL API is the single source for the pool *and* weekly scoring, so keying on its id means `gw_scores` joins for free. `value` is the FPL list price (e.g. 5.5), distinct from the auction `price`.
- **`picks.player_id` is UNIQUE.** This is exclusive ownership enforced in the database — the core Como rule. (If a future sport needs multipick, drop the constraint and gate on `config.multipick`.)
- **`picks.round`** reserves the rebid feature without a migration later. v1 only writes `round = 1`.
- **No budget/slot columns.** A manager's spend, remaining, and slot fill are *derived* from `picks` + config at read time (see `/api/state`). One source of truth, no sync bugs.

## API surface

| Method | Route | Who | Purpose |
|---|---|---|---|
| GET | `/api/state` | all (poll ~2s) | full live state: per-manager spend/remaining/slots + squads, last pick |
| GET | `/api/players` | all | pool with `drafted` flag; filter by position / undrafted |
| POST | `/api/draft` | commissioner (token) | record a sale `{playerId, managerId, price}`; validates + inserts |
| DELETE | `/api/draft` | commissioner (token) | undo a sale (mis-entry) |

### `/api/state` shape (what clients render)

```jsonc
{
  "config": { ...league.config },
  "squadSize": 15,
  "managers": [
    { "id": 6, "name": "...", "spent": 1945, "remaining": 55,
      "slotsFilled": 15, "slotsTotal": 15,
      "byPosition": { "GK": 2, "DEF": 5, "MID": 5, "FWD": 3 },
      "squad": [ { "playerId": 1, "name": "...", "team": "ARS", "position": "MID", "price": 1000 } ] }
  ],
  "lastPick": { ... },
  "totalPicks": 105
}
```

### Sale validation (`POST /api/draft`)

A sale is rejected unless all hold:
1. Player exists and is **not already in `picks`** (exclusivity).
2. Manager's **position quota** for that slot isn't full (`byPosition[pos] < squad[pos]`).
3. `price >= bidFloor` and **price <= manager remaining**.
4. Manager has a **free squad slot** (`slotsFilled < squadSize`).

All four run in one transaction so concurrent commissioner actions can't oversell.
