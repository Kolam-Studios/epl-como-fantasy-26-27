// Waiver form write path + manager-token auth (docs/DESIGN-WAIVERS.md 3B/3C
// and section 5). This is the platform's first NON-commissioner write:
// manager-scoped, gated by a per-manager token (its own header, never
// COMMISSIONER_TOKEN), every rule enforced server-side, every write audited.
//
// SECRECY: nobody can see anyone's bids or drops until the round resolves.
// Nothing in this file may leak a submission into any open read payload, and
// the token itself must never appear in a payload, a log line, or an audit row.
//
// Plain JS with the postgres.js client + config INJECTED (repo -core
// convention) so the integration suite drives the exact code the routes serve.

import { createHash, timingSafeEqual } from "node:crypto";
import { withAuctionLock } from "./draft-core.mjs";
import { loadOwnershipContext } from "./ownership-core.mjs";
import {
  auctionSpendByManager,
  deriveManager,
  resolveOwnership,
  tradeCashByManager,
  displayNames,
} from "./derive-core.mjs";

/** @typedef {import("./config-core.mjs").LeagueConfig} LeagueConfig */

/** Case-insensitive token folding: one memorable word, whitespace-tolerant. */
export function foldToken(token) {
  return String(token ?? "").trim().toLowerCase();
}

/** Hash a manager token for at-rest storage (sha256 hex of the folded word). */
export function hashManagerToken(token) {
  return createHash("sha256").update(foldToken(token)).digest("hex");
}

/** Constant-time hex-hash comparison. */
function hashesEqual(aHex, bHex) {
  const a = Buffer.from(String(aHex), "hex");
  const b = Buffer.from(String(bHex), "hex");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/**
 * True when `token` is the given manager's current token. Never reveals
 * WHETHER a token exists: a manager with no token row compares against a
 * random hash so the caller (and the clock) see the same "no" either way.
 *
 * @param {import("postgres").Sql | import("postgres").TransactionSql} db
 * @param {number} managerId
 * @param {string} token
 */
export async function verifyManagerToken(db, managerId, token) {
  const [row] = await db`select token_hash from manager_tokens where manager_id = ${managerId}`;
  const stored = row?.token_hash ?? createHash("sha256").update(String(Math.random())).digest("hex");
  const ok = hashesEqual(hashManagerToken(token), stored);
  return ok && row != null;
}

/**
 * Find which manager a token belongs to (the token history page's lookup).
 * Compares against every stored hash (a handful of rows); returns the
 * manager id or null. Same generic outcome for "wrong token" and "no tokens".
 *
 * @param {import("postgres").Sql} db
 * @param {string} token
 * @returns {Promise<number | null>}
 */
export async function managerIdForToken(db, token) {
  const presented = hashManagerToken(token);
  const rows = await db`select manager_id, token_hash from manager_tokens`;
  let found = null;
  for (const r of rows) {
    // Constant-shape loop: compare every row, no early exit.
    if (hashesEqual(presented, r.token_hash)) found = r.manager_id;
  }
  return found;
}

/** Set (or rotate) a manager's token. Audits the ROTATION, never the word. */
export async function setManagerToken(db, managerId, token, actor) {
  const hash = hashManagerToken(token);
  const [existing] = await db`select manager_id from manager_tokens where manager_id = ${managerId}`;
  await db`
    insert into manager_tokens (manager_id, token_hash)
    values (${managerId}, ${hash})
    on conflict (manager_id) do update
      set token_hash = excluded.token_hash, rotated_at = now()
  `;
  await db`
    insert into audit_log (actor, action, entity, entity_id, after)
    values (${actor}, ${existing ? "token.rotate" : "token.create"}, 'manager_tokens', ${managerId},
            ${db.json({ managerId })})
  `;
}

/** The current period row, locked-world view. Null when no pointer is set. */
async function currentPeriodRow(db) {
  const [p] = await db`
    select p.id, p.seq, p.label, p.kind, p.season, p.status, p.cutoff_at
    from app_state a join periods p on p.id = a.current_period_id
    where a.id = 1
  `;
  return p ?? null;
}

/**
 * The latest (effective) submission for a (period, manager), with drops and
 * bids, or null. Drops come back in priority order, bids in form order.
 *
 * @param {import("postgres").Sql | import("postgres").TransactionSql} db
 */
export async function latestSubmission(db, periodId, managerId) {
  const [sub] = await db`
    select id, submitted_at from waiver_submissions
    where period_id = ${periodId} and manager_id = ${managerId}
    order by submitted_at desc, id desc
    limit 1
  `;
  if (!sub) return null;
  const [drops, bids] = await Promise.all([
    db`
      select wd.player_id, wd.priority, p.web_name, p.team_short, p.position
      from waiver_drops wd join players p on p.id = wd.player_id
      where wd.submission_id = ${sub.id}
      order by wd.priority
    `,
    db`
      select wb.player_id, wb.amount, wb.bid_order, p.web_name, p.team_short, p.position
      from waiver_bids wb join players p on p.id = wb.player_id
      where wb.submission_id = ${sub.id}
      order by wb.bid_order
    `,
  ]);
  return {
    submissionId: sub.id,
    submittedAt: new Date(sub.submitted_at).toISOString(),
    drops: drops.map((d) => ({
      playerId: d.player_id,
      priority: d.priority,
      name: d.web_name,
      teamShort: d.team_short,
      position: d.position,
    })),
    bids: bids.map((b) => ({
      playerId: b.player_id,
      amount: b.amount,
      bidOrder: b.bid_order,
      name: b.web_name,
      teamShort: b.team_short,
      position: b.position,
    })),
  };
}

/** @param {string} code @param {string} message */
function reject(code, message) {
  return { ok: false, code, message };
}

/**
 * Step-1 context for the waiver form: verify the (manager, token) pair, then
 * return the manager's live money/squad plus any saved form for the current
 * period. A mismatched pair gets ONE generic rejection, whichever half was
 * wrong, so the endpoint cannot be used to probe which tokens exist.
 *
 * @param {import("postgres").Sql} sql
 * @param {LeagueConfig} cfg
 * @param {{managerId: number, token: string}} args
 */
export async function waiverContext(sql, cfg, { managerId, token }) {
  if (!Number.isInteger(managerId)) return reject("bad_manager", "managerId must be a whole number.");
  const period = await currentPeriodRow(sql);
  if (!period || period.kind !== "waiver") {
    return reject("no_waiver", "No waiver period is live right now.");
  }
  const [mgr] = await sql`select id, slot, short, sat_out from managers where id = ${managerId}`;
  const tokenOk = mgr ? await verifyManagerToken(sql, managerId, token) : false;
  if (!mgr || mgr.sat_out || !tokenOk) {
    return reject("no_match", "That manager and token do not match.");
  }

  const ctx = await loadOwnershipContext(sql);
  const ownership = resolveOwnership(ctx.sales, ctx.movements);
  const owned = ownership.filter((o) => o.managerId === managerId);
  const derived = deriveManager(
    cfg,
    owned,
    tradeCashByManager(ctx.trades)[managerId] || 0,
    auctionSpendByManager(ctx.spendRows)[managerId] || 0,
  );
  const nameRows = await sql`select id, web_name, team_short, position from players where id in ${
    owned.length ? sql(owned.map((o) => o.playerId)) : sql([0])
  }`;
  const labels = displayNames(
    (await sql`select id, web_name, team_short from players`).map((r) => ({
      id: r.id, webName: r.web_name, teamShort: r.team_short,
    })),
  );
  const detail = new Map(nameRows.map((r) => [r.id, r]));
  const saved = await latestSubmission(sql, period.id, managerId);

  return {
    ok: true,
    period: {
      id: period.id, seq: period.seq, label: period.label,
      cutoffAt: period.cutoff_at ? new Date(period.cutoff_at).toISOString() : null,
      status: period.status,
    },
    manager: { id: mgr.id, slot: mgr.slot, short: mgr.short },
    remaining: derived.remaining,
    squad: owned
      .map((o) => {
        const d = detail.get(o.playerId);
        return {
          playerId: o.playerId,
          name: d?.web_name ?? null,
          displayName: labels.get(o.playerId) ?? d?.web_name ?? null,
          teamShort: d?.team_short ?? null,
          position: o.position,
          salary: o.price,
        };
      })
      .sort((a, b) =>
        ["GK", "DEF", "MID", "FWD"].indexOf(a.position) - ["GK", "DEF", "MID", "FWD"].indexOf(b.position) ||
        b.salary - a.salary,
      ),
    saved,
  };
}

/**
 * THE submission write (spec 3B server-side validation, verbatim):
 * token matches manager; manager is active this period; every dropped player
 * is currently owned by the manager; every bid target is a free agent;
 * amounts are whole dollars 1..remaining; at most one bid per player;
 * submission lands before the cutoff. Any number of forms may be submitted;
 * the latest before the cutoff is the effective one.
 *
 * Runs inside the auction lock so ownership/budget reads cannot race a trade
 * being recorded at the same instant.
 *
 * @param {import("postgres").Sql} sql
 * @param {LeagueConfig} cfg
 * @param {{managerId: number, token: string,
 *          drops: Array<{playerId: number}>,
 *          bids: Array<{playerId: number, amount: number}>,
 *          actor?: string}} args
 */
export async function submitWaiverForm(sql, cfg, { managerId, token, drops, bids, actor }) {
  // ---- shape validation (no DB needed) ----------------------------------
  if (!Number.isInteger(managerId)) return reject("bad_manager", "managerId must be a whole number.");
  if (!Array.isArray(drops) || !Array.isArray(bids)) {
    return reject("bad_shape", "drops and bids must both be arrays.");
  }
  for (const d of drops) {
    if (!d || !Number.isInteger(d.playerId)) {
      return reject("bad_drop", "Every drop needs a whole-number playerId.");
    }
  }
  const dropIds = drops.map((d) => d.playerId);
  if (new Set(dropIds).size !== dropIds.length) {
    return reject("dup_drop", "A player can only be nominated to drop once.");
  }
  for (const b of bids) {
    if (!b || !Number.isInteger(b.playerId)) {
      return reject("bad_bid", "Every bid needs a whole-number playerId.");
    }
    if (!Number.isInteger(b.amount) || b.amount < 1) {
      return reject("bad_amount", `Bids are whole dollars, minimum $1 (got ${JSON.stringify(b.amount)}).`);
    }
  }
  const bidIds = bids.map((b) => b.playerId);
  if (new Set(bidIds).size !== bidIds.length) {
    return reject("dup_bid", "At most one bid per player per form.");
  }

  return await withAuctionLock(sql, async (tx) => {
    // ---- the live period ------------------------------------------------
    const period = await currentPeriodRow(tx);
    if (!period || period.kind !== "waiver") {
      return reject("no_waiver", "No waiver period is live right now.");
    }
    if (period.status !== "open") {
      return reject(
        "period_not_open",
        period.status === "resolving"
          ? `${period.label} is resolving; submissions are closed.`
          : `${period.label} is ${period.status}; submissions are closed.`,
      );
    }
    const [{ now }] = await tx`select now() as now`;
    if (period.cutoff_at && new Date(now) >= new Date(period.cutoff_at)) {
      return reject("past_cutoff", `${period.label} closed at its cutoff; this form arrived too late.`);
    }

    // ---- who you are ------------------------------------------------------
    const [mgr] = await tx`select id, slot, short, sat_out from managers where id = ${managerId}`;
    const tokenOk = mgr ? await verifyManagerToken(tx, managerId, token) : false;
    if (!mgr || mgr.sat_out || !tokenOk) {
      return reject("no_match", "That manager and token do not match.");
    }

    // ---- world state: ownership + money -----------------------------------
    const ctx = await loadOwnershipContext(tx);
    const ownership = resolveOwnership(ctx.sales, ctx.movements);
    const ownerByPlayer = new Map(ownership.map((o) => [o.playerId, o.managerId]));
    const owned = ownership.filter((o) => o.managerId === managerId);
    const derived = deriveManager(
      cfg,
      owned,
      tradeCashByManager(ctx.trades)[managerId] || 0,
      auctionSpendByManager(ctx.spendRows)[managerId] || 0,
    );

    // Every nominated drop must be currently owned by this manager.
    const posById = new Map(owned.map((o) => [o.playerId, o.position]));
    for (const id of dropIds) {
      if (ownerByPlayer.get(id) !== managerId) {
        return reject("drop_not_owned", `Player ${id} is not on ${mgr.short}'s squad, so it cannot be nominated as a drop.`);
      }
    }

    // Every bid target must exist and be a free agent.
    const bidRows = bidIds.length
      ? await tx`select id, position from players where id in ${tx(bidIds)}`
      : [];
    const bidPos = new Map(bidRows.map((r) => [r.id, r.position]));
    for (const id of bidIds) {
      if (!bidPos.has(id)) return reject("unknown_player", `No player with id ${id} exists in the pool.`);
      if (ownerByPlayer.has(id)) {
        return reject("not_free_agent", `Player ${id} is owned, not a free agent; waiver bids only target free agents.`);
      }
    }

    // Whole-wallet cap: each bid at most the manager's full remaining budget.
    for (const b of bids) {
      if (b.amount > derived.remaining) {
        return reject(
          "over_cap",
          `A $${b.amount} bid exceeds ${mgr.short}'s remaining budget of $${derived.remaining}.`,
        );
      }
    }

    // Warnings, never blocks (spec 3B): a bid on a position with no nominated
    // drop can never win; flag it so the form can restate the rule.
    const dropPositions = new Set(dropIds.map((id) => posById.get(id)));
    const warnings = [];
    for (const b of bids) {
      const pos = bidPos.get(b.playerId);
      if (!dropPositions.has(pos)) {
        warnings.push(
          `A bid on a ${pos} cannot win because no ${pos} drop is nominated on this form.`,
        );
      }
    }

    // ---- write: submission + drops (priority = form order) + bids ---------
    const [sub] = await tx`
      insert into waiver_submissions (period_id, manager_id)
      values (${period.id}, ${managerId})
      returning id, submitted_at
    `;
    for (const [i, d] of drops.entries()) {
      await tx`
        insert into waiver_drops (submission_id, player_id, priority)
        values (${sub.id}, ${d.playerId}, ${i + 1})
      `;
    }
    for (const [i, b] of bids.entries()) {
      await tx`
        insert into waiver_bids (submission_id, player_id, amount, bid_order)
        values (${sub.id}, ${b.playerId}, ${b.amount}, ${i + 1})
      `;
    }
    // Audit the act, not the secrets: counts only. The submission tables ARE
    // the full record for disputes; the audit log is the who-did-what trail.
    await tx`
      insert into audit_log (actor, action, entity, entity_id, after)
      values (${actor ?? "manager"}, 'waiver.submit', 'waiver_submissions', ${sub.id},
              ${tx.json({ periodId: period.id, managerId, drops: drops.length, bids: bids.length })})
    `;

    return {
      ok: true,
      submissionId: sub.id,
      submittedAt: new Date(sub.submitted_at).toISOString(),
      period: { id: period.id, label: period.label },
      warnings,
    };
  });
}

/**
 * Token history lookup (mockup C): everything a token's manager has ever
 * submitted, period by period, superseded versions included. Returns the
 * same empty shape for a wrong token as for a manager with no submissions -
 * the lookup NEVER confirms whether a token exists.
 *
 * @param {import("postgres").Sql} sql
 * @param {string} token
 */
export async function tokenHistory(sql, token) {
  const managerId = await managerIdForToken(sql, token);
  if (managerId == null) return { ok: true, found: false, periods: [] };

  const [mgr] = await sql`select id, slot, short from managers where id = ${managerId}`;
  const subs = await sql`
    select ws.id, ws.submitted_at, p.id as period_id, p.seq, p.label, p.status, p.cutoff_at
    from waiver_submissions ws
    join periods p on p.id = ws.period_id
    where ws.manager_id = ${managerId}
    order by p.seq desc, ws.submitted_at desc, ws.id desc
  `;
  if (subs.length === 0) return { ok: true, found: false, periods: [] };

  const subIds = subs.map((s) => s.id);
  const [dropRows, bidRows] = await Promise.all([
    sql`
      select wd.submission_id, wd.player_id, wd.priority, p.web_name, p.team_short, p.position
      from waiver_drops wd join players p on p.id = wd.player_id
      where wd.submission_id in ${sql(subIds)}
      order by wd.priority
    `,
    sql`
      select wb.submission_id, wb.player_id, wb.amount, wb.bid_order, p.web_name, p.team_short, p.position
      from waiver_bids wb join players p on p.id = wb.player_id
      where wb.submission_id in ${sql(subIds)}
      order by wb.bid_order
    `,
  ]);
  const dropsBySub = new Map();
  for (const d of dropRows) {
    const arr = dropsBySub.get(d.submission_id) || [];
    arr.push({ playerId: d.player_id, priority: d.priority, name: d.web_name, teamShort: d.team_short, position: d.position });
    dropsBySub.set(d.submission_id, arr);
  }
  const bidsBySub = new Map();
  for (const b of bidRows) {
    const arr = bidsBySub.get(b.submission_id) || [];
    arr.push({ playerId: b.player_id, amount: b.amount, bidOrder: b.bid_order, name: b.web_name, teamShort: b.team_short, position: b.position });
    bidsBySub.set(b.submission_id, arr);
  }

  /** @type {Map<number, {seq:number,label:string,status:string,cutoffAt:string|null,submissions:any[]}>} */
  const byPeriod = new Map();
  for (const s of subs) {
    if (!byPeriod.has(s.period_id)) {
      byPeriod.set(s.period_id, {
        seq: s.seq,
        label: s.label,
        status: s.status,
        cutoffAt: s.cutoff_at ? new Date(s.cutoff_at).toISOString() : null,
        submissions: [],
      });
    }
    byPeriod.get(s.period_id).submissions.push({
      submissionId: s.id,
      submittedAt: new Date(s.submitted_at).toISOString(),
      drops: dropsBySub.get(s.id) || [],
      bids: bidsBySub.get(s.id) || [],
    });
  }
  // Newest submission first inside a period; the first is the effective one.
  return {
    ok: true,
    found: true,
    manager: { id: mgr.id, slot: mgr.slot, short: mgr.short },
    periods: [...byPeriod.values()],
  };
}
