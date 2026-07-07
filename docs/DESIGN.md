# Product Design — Auction v1

> Status: DRAFT for review. Abbreviated design to lock requirements before build. Low-fi only — visual design comes at build time. Feeds `docs/PRD.md` acceptance criteria.
>
> **Visual design is now locked** — colors, type, and surface rules live in [`docs/VISUAL-DESIGN.md`](VISUAL-DESIGN.md), with a live sample at [`docs/wireframes/style-sketch.html`](wireframes/style-sketch.html).

## Surfaces (3, one responsive app, role by token)

| Surface | Audience | Mode | Layout |
|---|---|---|---|
| **Projector board** | the room | read-only | big, glanceable from across a room |
| **Commissioner panel** | one operator | read + write (token) | board + an entry/control strip |
| **Manager phone** | each manager | read-only | compact; "my team" first, then the board |

All three render the same `/api/state` (polled ~2s); the commissioner panel additionally `POST`s to `/api/draft`.

## The auction-night flow

```
  search/select player ──► PLAYER ON THE BLOCK  (broadcast to all surfaces)
            │                       │
            │                room bids verbally
            │                       │
            │             commissioner enters winner + £price
            │                       ▼
            │              POST /api/draft ──► validate ──► record sale
            │                       │                          │
            └──────────────◄────────┴──── board updates everywhere (~2s)
                  (or: PASS/CLEAR lot if no bids)        (or: UNDO last sale)
   repeat until every squad is full (15)
```

- **No nomination phase.** Lot order is the pool sorted by **FPL price, most expensive first** (the long-standing Como convention), with an optional **randomise-within-tier** shuffle. The commissioner advances through the queue; search/jump to skip.
- **Pause** is a first-class control: the commissioner can pause for trades, discussion, or a break, and every surface shows a clear PAUSED state.
- The commissioner is the **single writer**, so there is no bid contention to resolve.
- **Player-data overlay (easy/factual only):** the on-the-block player shows readily-available FPL history (club, position, price, last-season points, last-season starts/minutes). No AI start-prediction; pre-auction research stays with each bidder.

## The max-bid rule (the one bit of real logic)

A manager's **max allowable bid on the current lot** is position-aware and reserves £1 for each of their other empty slots:

```
openSlotThisPosition = squad[pos] - filled[m][pos]          // must be > 0 to bid at all
emptySlotsElsewhere  = (squadSize - slotsFilled[m]) - 1      // reserve £1 each
maxBid(m)            = openSlotThisPosition > 0
                         ? remaining[m] - max(0, emptySlotsElsewhere) * bidFloor
                         : —                                  // blocked: no slot for this position
```

So a manager with money but no empty GK slot **cannot** bid on a GK (shown as "—"). When a manager has one slot left, their max = full remaining. This is computed server-side in `/api/state` per manager for the current lot, and shown on every surface.

## Validation (server, one transaction) — rejects a sale unless all hold

1. Player exists and is **not already sold** (exclusive ownership).
2. Winner has an **open slot for that position**.
3. `price >= bidFloor` and `price <= maxBid(winner)` (the reserve rule above).
4. Winner has a free squad slot overall.

## States & edge cases

- **Drafted players** drop out of the search/pool; can't be re-nominated.
- **Blocked winners**: a manager who can't legally win the current lot (no position slot, or maxBid < floor) is greyed in the winner picker.
- **Pass / clear lot**: a nominated player with no bids is cleared without a sale (no pick row written).
- **Undo**: reverses the last sale, restoring budget + slot; the player returns to the pool.
- **Squad full**: a manager at 15 is excluded from the winner picker and shown "complete".
- **Late join / refresh**: any surface catches up on its next poll; no per-client state.

## Low-fi wireframes

### Projector board
```
┌──────────────────────────────────────────────────────────────┐
│  ON THE BLOCK:  HAALAND   FWD · MCI · Tier 1 · £14.0          │
│──────────────────────────────────────────────────────────────│
│ Manager   Rem    Slots(G/D/M/F)   MaxBid │ Manager   Rem ...  │
│ M1       £455    1/4/3/2          £452    │ M5      £1,210 ... │
│ M2       £980    2/5/4/2          £977    │ M6        £ 60 ... │
│ M3       £ 12    2/5/5/3  FULL    —       │ M7       £730  ... │
│ M4       £305    1/3/2/1          £302    │                    │
│──────────────────────────────────────────────────────────────│
│ Recently sold:  ISAK→M5 £800 · SALAH→M2 £1,000 · ...          │
│ Remaining pool:  GK 18 · DEF 92 · MID 130 · FWD 41           │
└──────────────────────────────────────────────────────────────┘
```

### Commissioner panel
```
┌─────────────────────────────────────────────┐
│ [ search player…  ]  filter: [POS▾][CLUB▾]   │
│  > Haaland  FWD MCI £14.0   [ SET ON BLOCK ] │
│  > Watkins  FWD AVL £8.5    [ SET ON BLOCK ] │
│─────────────────────────────────────────────│
│ ON THE BLOCK:  HAALAND  FWD · MCI            │
│ Winner: [ M1 ▾ ]   Price: [  ___  ]          │
│         (M3 FULL, M6 £60<floor greyed)       │
│        [ RECORD SALE ]   [ PASS/CLEAR ]      │
│─────────────────────────────────────────────│
│ Last: ISAK→M5 £800   [ UNDO ]                │
└─────────────────────────────────────────────┘
```

### Manager phone (read-only)
```
┌───────────────────────────┐
│ MY TEAM — M5              │
│ Rem £1,210 · 11/15 slots  │
│ Max bid (Haaland): £1,207 │
│ GK ✓✓  DEF ✓✓✓✓✓          │
│ MID ✓✓✓·· FWD ✓··         │
│ My squad: Isak £800, …    │
│───────────────────────────│
│ ON THE BLOCK: Haaland     │
│ Board: M1 £455 · M2 £980… │
└───────────────────────────┘
```

## What this confirms for the build

- `/api/state` returns, per manager: `remaining`, `slotsFilled`, `byPosition`, and a **`maxBidCurrentLot`** computed against the on-block player.
- A **current-lot** concept exists in state (set by the commissioner). Simplest: a single-row `lots`/`current_lot` the panel writes; or hold it in a lightweight `app_state` row. (Decide in build.)
- Three responsive layouts off one component tree; commissioner actions gated by `COMMISSIONER_TOKEN`.

## Still open (build-time, not blocking)

- Where "on the block" lives (DB row vs in-memory broadcast) — pick during build.
- Visual design / branding — frontend-design skill at build.
