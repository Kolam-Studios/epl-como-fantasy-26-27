// Period lifecycle + archiving (docs/DESIGN-WAIVERS.md sections 2.2 and 5).
// The season runs in periods: the August auction (period 1, "Bid 1"), monthly
// blind-bid waivers, the January rebid. A period moves
// locked -> open -> resolving -> closed, and at close it freezes into a
// period_snapshots row that archived pages render verbatim, never recomputing.
//
// Plain JS with the postgres.js client + config INJECTED (the repo's -core
// convention), so integration tests drive the exact same code the routes and
// scripts use.

import { configPeriods } from "./config-core.mjs";
import { buildRecapPayload } from "./recap-core.mjs";
import { buildPlayersPayload } from "./players-core.mjs";
import { buildTradesPayload } from "./trades-core.mjs";

/** Legal status moves. Everything else is a refused transition. */
const TRANSITIONS = {
  locked: ["open"],
  open: ["resolving"],
  resolving: ["closed", "open"], // "open" = a failed/aborted resolution backing out
  closed: [],
};

/**
 * Idempotently seed the periods table from config. seq is the upsert key;
 * label/kind/season/cutoff_at converge to config on every run; STATUS (and
 * opens_at, which the lifecycle stamps) are runtime state and are NEVER
 * touched here - re-running db:setup must not reopen or re-lock anything.
 *
 * @param {import("postgres").Sql | import("postgres").TransactionSql} sql
 * @param {import("./config-core.mjs").LeagueConfig} cfg
 * @returns {Promise<number>} how many periods the config defines
 */
export async function seedPeriods(sql, cfg) {
  const periods = configPeriods(cfg);
  for (const p of periods) {
    await sql`
      insert into periods (seq, label, kind, season, cutoff_at)
      values (${p.seq}, ${p.label}, ${p.kind}, ${p.season}, ${p.cutoffAt ?? null})
      on conflict (seq) do update
        set label = excluded.label,
            kind = excluded.kind,
            season = excluded.season,
            cutoff_at = excluded.cutoff_at
    `;
  }
  return periods.length;
}

/**
 * All periods in seq order, each with whether a frozen snapshot exists.
 * @param {import("postgres").Sql | import("postgres").TransactionSql} sql
 */
export async function listPeriods(sql) {
  const rows = await sql`
    select p.id, p.seq, p.label, p.kind, p.season, p.opens_at, p.cutoff_at, p.status,
           (ps.period_id is not null) as has_snapshot
    from periods p
    left join period_snapshots ps on ps.period_id = p.id
    order by p.seq
  `;
  return rows.map((r) => ({
    id: r.id,
    seq: r.seq,
    label: r.label,
    kind: r.kind,
    season: r.season,
    opensAt: r.opens_at ? new Date(r.opens_at).toISOString() : null,
    cutoffAt: r.cutoff_at ? new Date(r.cutoff_at).toISOString() : null,
    status: r.status,
    hasSnapshot: r.has_snapshot === true,
  }));
}

/**
 * The current (live) period per app_state.current_period_id, or null in the
 * pre-waiver-era world where the pointer was never set. Auction-era behavior
 * is unchanged when this returns null.
 * @param {import("postgres").Sql | import("postgres").TransactionSql} sql
 */
export async function getCurrentPeriod(sql) {
  const [row] = await sql`
    select p.id, p.seq, p.label, p.kind, p.season, p.opens_at, p.cutoff_at, p.status
    from app_state a
    join periods p on p.id = a.current_period_id
    where a.id = 1
  `;
  if (!row) return null;
  return {
    id: row.id,
    seq: row.seq,
    label: row.label,
    kind: row.kind,
    season: row.season,
    opensAt: row.opens_at ? new Date(row.opens_at).toISOString() : null,
    cutoffAt: row.cutoff_at ? new Date(row.cutoff_at).toISOString() : null,
    status: row.status,
  };
}

/**
 * The (period_id, stage-label) pair a money write should be stamped with,
 * given the already-locked app_state row. Null in the pre-waiver-era world
 * (current_period_id unset): callers then fall back to the legacy column
 * defaults ('auction-1'), leaving auction-night behavior byte-identical.
 *
 * @param {import("postgres").Sql | import("postgres").TransactionSql} db
 * @param {{current_period_id: number | null}} appState
 * @returns {Promise<{periodId: number, stage: string} | null>}
 */
export async function currentPeriodStamp(db, appState) {
  if (appState?.current_period_id == null) return null;
  const [p] = await db`select id, label from periods where id = ${appState.current_period_id}`;
  if (!p) return null;
  return { periodId: p.id, stage: p.label };
}

/**
 * THE BLACKOUT CHECK (docs/DESIGN-WAIVERS.md 2.3/4.4): while a waiver period
 * is between its cutoff and its published results, every money-state
 * mutation must hold - the engine runs on the budgets and rosters the forms
 * were final against. Trades, sale corrections and manual sales all consult
 * this before writing. Covers both the explicit 'resolving' status and the
 * gap between the cutoff instant and the Commissioners pressing resolve.
 *
 * @param {import("postgres").Sql | import("postgres").TransactionSql} db
 * @param {{current_period_id: number | null} | null | undefined} appState
 * @returns {Promise<{paused: boolean, label?: string}>}
 */
export async function waiverBlackout(db, appState) {
  if (appState?.current_period_id == null) return { paused: false };
  const [period] = await db`
    select label, kind, status, cutoff_at from periods where id = ${appState.current_period_id}
  `;
  if (!period || period.kind !== "waiver") return { paused: false };
  if (period.status === "resolving") return { paused: true, label: period.label };
  if (period.status === "open" && period.cutoff_at != null) {
    const [{ now }] = await db`select now() as now`;
    if (new Date(now) >= new Date(period.cutoff_at)) return { paused: true, label: period.label };
  }
  return { paused: false };
}

/**
 * Move one period's status along the lifecycle, refusing any move the
 * lifecycle does not allow. Writes an audit row. Callers own transactions and
 * version bumps; this only flips the row (and stamps opens_at on first open).
 *
 * @param {import("postgres").Sql | import("postgres").TransactionSql} db
 * @param {number} periodId
 * @param {"locked"|"open"|"resolving"|"closed"} to
 * @param {string} actor
 * @returns {Promise<{ok: true} | {ok: false, message: string}>}
 */
export async function transitionPeriod(db, periodId, to, actor) {
  const [p] = await db`select id, label, status from periods where id = ${periodId}`;
  if (!p) return { ok: false, message: `No period with id ${periodId} exists.` };
  const allowed = TRANSITIONS[p.status] ?? [];
  if (!allowed.includes(to)) {
    return {
      ok: false,
      message: `Period "${p.label}" is ${p.status}; it cannot move to ${to} (allowed: ${allowed.join(", ") || "none"}).`,
    };
  }
  if (to === "open") {
    await db`update periods set status = 'open', opens_at = coalesce(opens_at, now()) where id = ${periodId}`;
  } else {
    await db`update periods set status = ${to} where id = ${periodId}`;
  }
  await db`
    insert into audit_log (actor, action, entity, entity_id, before, after)
    values (${actor}, 'period.transition', 'periods', ${periodId},
            ${db.json({ status: p.status })}, ${db.json({ status: to })})
  `;
  return { ok: true };
}

/**
 * Assemble the frozen-archive payload for a period AS THE WORLD STANDS NOW.
 * Reuses the exact read assemblies the live pages serve (recap = budgets,
 * squads, awards; players = the ledger; trades = the trade log), so the
 * archive is pixel-compatible with the live surfaces. The trades list is
 * filtered to THIS period's rows (by period_id, falling back to stage =
 * label for pre-backfill rows); budgets/squads/ledger are the cumulative
 * state at freeze time, which is exactly what "the ledger as it stood at
 * close" means.
 *
 * SEALING: recap/players assemblies only unseal values on sold rows; nothing
 * here widens that.
 *
 * @param {import("postgres").Sql} sql
 * @param {import("./config-core.mjs").LeagueConfig} cfg
 * @param {{id: number, label: string, seq: number, kind: string, season: string}} period
 */
export async function buildPeriodSnapshotPayload(sql, cfg, period) {
  const [recap, players, trades] = await Promise.all([
    buildRecapPayload(sql, cfg),
    buildPlayersPayload(sql, cfg),
    buildTradesPayload(sql, cfg),
  ]);
  const periodTrades = trades.trades.filter(
    (t) => t.periodId === period.id || (t.periodId == null && t.stage === period.label) ||
           (t.periodId == null && period.seq === 1),
  );
  return {
    schemaVersion: 1,
    period: {
      id: period.id,
      seq: period.seq,
      label: period.label,
      kind: period.kind,
      season: period.season,
    },
    recap,
    players,
    trades: { ...trades, trades: periodTrades },
  };
}

/**
 * Freeze a period's snapshot (write-once: refuses to overwrite an existing
 * snapshot so an archive can never be silently rewritten).
 *
 * @param {import("postgres").Sql | import("postgres").TransactionSql} db
 * @param {number} periodId
 * @param {unknown} payload
 * @returns {Promise<{ok: true} | {ok: false, message: string}>}
 */
export async function freezeSnapshot(db, periodId, payload) {
  const inserted = await db`
    insert into period_snapshots (period_id, payload)
    values (${periodId}, ${db.json(payload)})
    on conflict (period_id) do nothing
    returning period_id
  `;
  if (inserted.length === 0) {
    return { ok: false, message: `Period ${periodId} already has a frozen snapshot; refusing to overwrite.` };
  }
  return { ok: true };
}

/**
 * Read a frozen snapshot (null when the period has none).
 * @param {import("postgres").Sql} sql
 * @param {number} periodId
 */
export async function getSnapshot(sql, periodId) {
  const [row] = await sql`
    select payload, frozen_at from period_snapshots where period_id = ${periodId}
  `;
  if (!row) return null;
  return { payload: row.payload, frozenAt: new Date(row.frozen_at).toISOString() };
}

/**
 * Backfill the completed August auction as archived period 1 ("Bid 1") and
 * open the next period. Idempotent end state; safe to re-run:
 *   1. seed periods from config (no-op when already seeded)
 *   2. stamp period_id = period 1 on every auction-era sales/trades row
 *      (period_id is null and stage = 'auction-1')
 *   3. freeze period 1's snapshot (skipped if one exists)
 *   4. close period 1, open the next period, point app_state at it
 *   5. audit + version bump
 *
 * The snapshot is built OUTSIDE the transaction (pure reads), the state flip
 * happens inside one transaction serialised on the app_state row lock.
 *
 * @param {import("postgres").Sql} sql
 * @param {import("./config-core.mjs").LeagueConfig} cfg
 * @param {{actor?: string}} [opts]
 * @returns {Promise<{ok: boolean, notes: string[]}>}
 */
export async function backfillBidOne(sql, cfg, { actor = "backfill" } = {}) {
  const notes = [];
  await seedPeriods(sql, cfg);

  const periods = await listPeriods(sql);
  if (periods.length === 0) return { ok: false, notes: ["config defines no periods; nothing to backfill"] };
  const bidOne = periods[0];
  const next = periods[1] ?? null;

  // Snapshot payload from pure reads (only when we will need it).
  let payload = null;
  const hasSnap = bidOne.hasSnapshot;
  if (!hasSnap) payload = await buildPeriodSnapshotPayload(sql, cfg, bidOne);

  return await sql.begin(async (tx) => {
    const [appState] = await tx`select * from app_state where id = 1 for update`;
    if (!appState) return { ok: false, notes: ["app_state missing; run db:setup first"] };

    // (2) stamp the auction-era money rows.
    const stampedSales = await tx`
      update sales set period_id = ${bidOne.id}
      where period_id is null and stage = 'auction-1'
      returning id
    `;
    const stampedTrades = await tx`
      update trades set period_id = ${bidOne.id}
      where period_id is null and stage = 'auction-1'
      returning id
    `;
    notes.push(`stamped ${stampedSales.length} sales, ${stampedTrades.length} trades as "${bidOne.label}"`);

    // (3) freeze the archive.
    if (payload) {
      const froze = await freezeSnapshot(tx, bidOne.id, payload);
      notes.push(froze.ok ? `froze "${bidOne.label}" snapshot` : froze.message);
    } else {
      notes.push(`"${bidOne.label}" snapshot already frozen; left untouched`);
    }

    // (4) close period 1 (locked -> open -> resolving -> closed, walked
    // through the lifecycle so the transition table stays the single
    // authority), then open the next period.
    if (bidOne.status !== "closed") {
      for (const step of ["open", "resolving", "closed"]) {
        const [cur] = await tx`select status from periods where id = ${bidOne.id}`;
        if (cur.status === step) continue;
        const t = await transitionPeriod(tx, bidOne.id, step, actor);
        if (!t.ok) return { ok: false, notes: [...notes, t.message] };
      }
      notes.push(`closed "${bidOne.label}"`);
    }
    if (next && next.status === "locked") {
      const t = await transitionPeriod(tx, next.id, "open", actor);
      if (!t.ok) return { ok: false, notes: [...notes, t.message] };
      notes.push(`opened "${next.label}"`);
    }
    const currentId = next ? next.id : bidOne.id;
    if (appState.current_period_id !== currentId) {
      await tx`update app_state set current_period_id = ${currentId}, version = version + 1 where id = 1`;
      notes.push(`app_state.current_period_id -> ${currentId}`);
    }
    await tx`
      insert into audit_log (actor, action, entity, entity_id, after)
      values (${actor}, 'period.backfill', 'periods', ${bidOne.id},
              ${tx.json({ stampedSales: stampedSales.length, stampedTrades: stampedTrades.length })})
    `;
    return { ok: true, notes };
  });
}
