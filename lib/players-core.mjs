// Assembles the GET /api/players payload: every player in the pool with its
// current ownership (resolved THROUGH trades), the price paid, and the sealed
// Claude value REVEALED ONLY for sold players. Powers the ledger (/ledger, one
// row per player) and the squads screen (/squads, players grouped by manager).
// Plain JS with the postgres.js client + config INJECTED, so the integration
// test (scripts/test-players.mjs) drives the exact same assembly the route
// serves, without a build step. lib/players.ts wraps this with the app's shared
// pool + config; app/api/players/route.ts is a thin wrapper over that.
//
// SEALING IS STRUCTURAL HERE, exactly as in lib/state-core.mjs: the valuations
// table is joined in EXACTLY ONE query - soldValueQuery - which starts FROM
// sales. A valuation can therefore only ever ride on a player that has a
// current sales row. The all-players query never mentions valuations at all, so
// an unsold player cannot carry a value: not by a view filter, by the shape of
// the query. If you add a second valuations join, you have broken the seal.

import {
  deriveManagers,
  displayNames,
  resolveOwnership,
  saleVerdict,
  tradeCashByManager,
} from "./derive-core.mjs";

/** @typedef {import("./config-core.mjs").LeagueConfig} LeagueConfig */

/** numeric columns come back from postgres.js as strings */
function num(v) {
  return v == null ? null : Number(v);
}

/**
 * Read the draft-morning calibrated reveal band (#70) from the valuation_meta
 * singleton, NEVER throwing: a DB error, or a database that predates the
 * valuation_meta migration, returns null so saleVerdict falls back to
 * config.valueBadgeThreshold. This is the "AI must never block the auction"
 * guard at the read layer - the ledger stays up even if the band is missing.
 */
async function readFairBand(sql) {
  try {
    const rows = await sql`select fair_band from valuation_meta where id = 1`;
    const b = rows[0]?.fair_band;
    return b == null ? null : Number(b);
  } catch {
    return null;
  }
}

/**
 * Build the whole /api/players payload.
 *
 * @param {import("postgres").Sql} sql  a postgres.js client
 * @param {LeagueConfig} cfg
 */
export async function buildPlayersPayload(sql, cfg) {
  const [
    appStateRows,
    managerRows,
    playerRows,
    soldValueRows,
    moveRows,
    tradeRows,
    noBidRows,
    fairBand,
  ] = await Promise.all([
    sql`select version from app_state where id = 1`,
    sql`select id, slot, short from managers order by slot`,
    // Every player. NO valuations join here - structurally sealed.
    sql`
      select p.id, p.code, p.web_name, p.team_short, p.team_code,
             p.position, p.tier, p.fpl_price, p.pts
      from players p
      order by p.pts desc nulls last, p.id
    `,
    // The ONLY query that touches valuations: rooted in sales, so a value can
    // only appear for a player that is currently sold. `price` is the salary
    // (it travels with the player through trades); `value` is the player's own
    // sealed valuation (keyed by player_id, so it stays with the player).
    // lot_no + created_at ride along ONLY to derive the per-sale bid-order
    // sequence (#69) - neither is a valuation, so the seal is intact.
    sql`
      select s.player_id, s.manager_id, s.price, s.lot_no, s.created_at, v.value
      from sales s
      left join valuations v on v.player_id = s.player_id
    `,
    // Non-voided trade movements, oldest-first (trade id as the seq) - folded
    // into ownership below so every owner/price is post-trade correct.
    sql`
      select tp.player_id, tp.from_manager, tp.to_manager, t.id as seq
      from trade_players tp
      join trades t on t.id = tp.trade_id
      where t.voided = false
      order by t.id
    `,
    // Non-voided trade cash, for the per-manager spend/remaining maths.
    sql`
      select id, manager_a, manager_b, cash_a_to_b, cash_b_to_a
      from trades
      where voided = false
    `,
    // Players that were passed over with no bid (the ledger's NO BID marker).
    // A player later sold is no longer "no bid", so we intersect with unsold
    // below.
    sql`select distinct player_id from lot_events where event = 'no_bid'`,
    // Draft-morning calibrated reveal band (#70); null falls back to config.
    readFairBand(sql),
  ]);

  const version = appStateRows[0] ? Number(appStateRows[0].version) : 0;
  const managerShortById = new Map(managerRows.map((m) => [m.id, m.short]));
  const managerSlotById = new Map(managerRows.map((m) => [m.id, m.slot]));

  // Player display details, keyed by id, from the un-valued players query.
  const posByPlayer = new Map(playerRows.map((r) => [r.id, r.position]));

  // Disambiguated on-screen names (#44): unique web_name, else "Name (CLUB)".
  // Computed over the WHOLE pool so a shared surname is always qualified.
  const displayNameById = displayNames(
    playerRows.map((r) => ({ id: r.id, webName: r.web_name, teamShort: r.team_short })),
  );

  // Salary + sealed value per SOLD player, keyed by id. This is the sole
  // carrier of `value` in the whole payload.
  const soldById = new Map(
    soldValueRows.map((r) => [
      r.player_id,
      { managerId: r.manager_id, price: r.price, value: num(r.value) },
    ]),
  );

  // --- ownership resolved THROUGH trades ------------------------------
  const movements = moveRows.map((r) => ({
    playerId: r.player_id,
    fromManager: r.from_manager,
    toManager: r.to_manager,
    seq: Number(r.seq),
  }));
  const ownership = resolveOwnership(
    soldValueRows.map((r) => ({
      playerId: r.player_id,
      managerId: r.manager_id,
      price: r.price,
      position: posByPlayer.get(r.player_id) ?? null,
    })),
    movements,
  );
  // Current owner per player (post-trade). Salary travels with the player, so
  // ownedByPlayer.price is the salary; the sealed value stays keyed by id in
  // soldById (a valuation belongs to a player, not to whoever holds them now).
  const ownedByPlayer = new Map(ownership.map((o) => [o.playerId, o]));

  const cashByManager = tradeCashByManager(
    tradeRows.map((t) => ({
      managerA: t.manager_a,
      managerB: t.manager_b,
      cashAToB: t.cash_a_to_b,
      cashBToA: t.cash_b_to_a,
    })),
  );
  const derived = deriveManagers(cfg, managerRows, ownership, cashByManager);

  const noBidSet = new Set(noBidRows.map((r) => r.player_id));

  // --- per-sale bid-order sequence (#69) -----------------------------
  // The order players were bid on, as a clean dense 1..N. lot_no is the running
  // lot number stamped at sale time; where it is null (rows created before lot
  // numbering, or a forged fixture) we fall back to created_at, then id. It is
  // dense-ranked - not the raw lot_no - so the ledger reads 1, 2, 3 even though
  // lot_no legitimately skips numbers (no-bid lots consume a lot_no too). Keyed
  // by player_id: the sale is unique per player and stays with the player
  // through trades, so a traded player keeps the sequence of its purchase.
  const saleSeqByPlayer = new Map();
  soldValueRows
    .map((r) => ({
      playerId: r.player_id,
      lotNo: r.lot_no == null ? null : Number(r.lot_no),
      createdAt: r.created_at ? new Date(r.created_at).getTime() : 0,
    }))
    .sort((a, b) => {
      const al = a.lotNo == null ? Infinity : a.lotNo;
      const bl = b.lotNo == null ? Infinity : b.lotNo;
      if (al !== bl) return al - bl;
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.playerId - b.playerId;
    })
    .forEach((row, i) => saleSeqByPlayer.set(row.playerId, i + 1));

  // --- one row per player --------------------------------------------
  const players = playerRows.map((r) => {
    const owned = ownedByPlayer.get(r.id) ?? null;
    const sold = owned != null;
    // value is read ONLY from soldById (sales-rooted). Unsold => undefined =>
    // null. This is the structural seal.
    const value = sold ? (soldById.get(r.id)?.value ?? null) : null;
    const price = sold ? owned.price : null;
    const v = sold ? saleVerdict(cfg, price, value, fairBand) : { delta: null, verdict: null };
    return {
      id: r.id,
      code: r.code,
      name: r.web_name,
      // Disambiguated label for every on-screen surface; raw web_name stays on
      // `name`. Falls back to the raw name if somehow unmapped.
      displayName: displayNameById.get(r.id) ?? r.web_name,
      teamShort: r.team_short,
      teamCode: r.team_code,
      position: r.position,
      tier: r.tier,
      fplPrice: num(r.fpl_price),
      pts: r.pts,
      sold,
      // Bid-order sequence (#69): only sold players have one; unsold => null.
      seq: sold ? (saleSeqByPlayer.get(r.id) ?? null) : null,
      ownerSlot: sold ? (managerSlotById.get(owned.managerId) ?? null) : null,
      ownerShort: sold ? (managerShortById.get(owned.managerId) ?? null) : null,
      price,
      value,
      delta: v.delta,
      verdict: v.verdict,
      // NO BID only for players not currently owned (a later sale clears it).
      noBid: !sold && noBidSet.has(r.id),
    };
  });

  // --- per-manager summary (squads screen) ---------------------------
  // squadPlayerIds are this manager's currently-owned players (post-trade),
  // oldest-first. claudeValue sums the sealed values of those players (all of
  // them are sold, so their values are unsealed); claudeDelta compares that
  // total to what the manager has actually spent.
  const ownedByManager = new Map();
  for (const o of ownership) {
    const arr = ownedByManager.get(o.managerId) || [];
    arr.push(o.playerId);
    ownedByManager.set(o.managerId, arr);
  }
  const managers = derived.map((m) => {
    const ids = (ownedByManager.get(m.managerId) || []).slice().reverse();
    let valueSum = 0;
    let haveAnyValue = false;
    for (const id of ids) {
      const val = soldById.get(id)?.value;
      if (val != null) {
        valueSum += val;
        haveAnyValue = true;
      }
    }
    const claudeValue = haveAnyValue ? valueSum : null;
    return {
      id: m.managerId,
      slot: m.slot,
      short: m.short,
      spent: m.spent,
      remaining: m.remaining,
      openSlots: m.openSlots,
      squadComplete: m.squadComplete,
      maxBid: m.maxBid,
      squadPlayerIds: ids,
      claudeValue,
      claudeDelta: claudeValue == null ? null : claudeValue - m.spent,
    };
  });

  return {
    version,
    players,
    managers,
    squad: cfg.squad,
    pollMs: cfg.pollMs,
    generatedAt: new Date().toISOString(),
  };
}
