-- EPL Como Fantasy 26/27 — Postgres schema
-- Idempotent: safe to re-run. Config (budget, squad, managers) lives in
-- league.config.json, NOT here, so the schema is season-agnostic.

create table if not exists managers (
  id        serial primary key,
  name      text not null unique
);

-- Player pool, sourced from the FPL API (scripts/ingest-fpl.mjs).
create table if not exists players (
  id        integer primary key,          -- FPL element id
  name      text not null,
  team      text not null,                -- club short name (e.g. ARS)
  position  text not null check (position in ('GK','DEF','MID','FWD')),
  value     numeric(4,1) not null,        -- FPL list price (NOT the auction price)
  tier      integer,                      -- banding, lower = pricier
  updated   timestamptz not null default now()
);

-- The draft log. One row per sold lot. Exclusive ownership is enforced by the
-- unique constraint on player_id (no multipick in EPL Como).
create table if not exists picks (
  id          serial primary key,
  player_id   integer not null references players(id),
  manager_id  integer not null references managers(id),
  price       integer not null check (price >= 0),
  round       integer not null default 1, -- 1 = main draft; >1 reserved for rebids
  created_at  timestamptz not null default now(),
  unique (player_id)
);

create index if not exists picks_manager_idx on picks(manager_id);

-- Phase 2 (season tracker) — official FPL gameweek points per player.
-- Populated by a weekly ingest; standings = sum over a manager's owned players.
create table if not exists gw_scores (
  player_id  integer not null references players(id),
  gw         integer not null,
  points     integer not null default 0,
  primary key (player_id, gw)
);
