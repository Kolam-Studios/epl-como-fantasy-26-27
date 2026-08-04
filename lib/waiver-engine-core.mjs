// THE WAIVER ENGINE (docs/DESIGN-WAIVERS.md section 4) - the correctness-
// critical core of the waiver era, treated with the same care as /api/draft.
//
// Two layers, deliberately separated:
//   computeResolution  - a PURE function of (effective forms, budgets, seed).
//                        No DB, no clock, no randomness of its own. The
//                        worked example in spec 4.3 is its permanent fixture
//                        (scripts/test-waiver-engine.mjs).
//   resolveWaiverPeriod - the orchestrator: re-validates the world inside the
//                        serialising auction lock, runs the pure walk, and
//                        applies everything in ONE transaction (results,
//                        outcomes, a sales row per win, drops + released
//                        flags, audit, close + snapshot, open next period,
//                        version bump). Dry-run computes and returns without
//                        writing a single row.
//
// Money rules baked in: skips spend nothing; drops refund nothing; funds are
// checked against the WORKING budget so early wins price out later bids;
// every award consumes one same-position drop slot and releases the
// highest-priority still-owned nominated drop.

import { createHash, randomBytes } from "node:crypto";
import { withAuctionLock } from "./draft-core.mjs";
import { loadOwnershipContext } from "./ownership-core.mjs";
import {
  auctionSpendByManager,
  deriveManager,
  resolveOwnership,
  tradeCashByManager,
} from "./derive-core.mjs";
import { buildPeriodSnapshotPayload, freezeSnapshot, transitionPeriod } from "./period-core.mjs";

/** @typedef {import("./config-core.mjs").LeagueConfig} LeagueConfig */

/**
 * Deterministic per-bid rank from the published seed. Lexicographic order of
 * sha256(seed:manager:player) - replayable by anyone holding the seed.
 */
function seedRank(seed, managerId, playerId) {
  return createHash("sha256").update(`${seed}:${managerId}:${playerId}`).digest("hex");
}

/**
 * Sort every bid into the single walk order (spec 4.2 rule 2):
 *   a. amount, high to low
 *   b. equal amounts on the SAME player: larger bid as a proportion of that
 *      manager's start-of-round remaining wins (equivalently the smaller
 *      purse); still equal -> seed order
 *   c. equal amounts WITHIN one manager: the order the bids appear on the form
 *   d. all other equal-amount pairs contend for nothing: seed order
 *
 * The rules are PAIRWISE and can conflict through an intermediary (manager M
 * holds equal bids on P1 and P2; a rival contests P1: 2c orders M's pair, 2b
 * orders the contested player, and a naive comparator becomes intransitive -
 * Array.sort would then let the WINNER of a real-money tie depend on input
 * order). So this is built structurally instead of compared pairwise:
 *
 *   1. Take each equal-amount band in turn (rule a).
 *   2. Inside a band, group bids by player; within a group order by
 *      proportion, then seed (rule b is therefore ABSOLUTE - the group is
 *      contiguous in the walk, best claim first).
 *   3. Order the groups: whenever one manager holds bids in two groups, their
 *      form order (rule c) directs which group comes first; the groups are
 *      then emitted in seeded topological order, and any conflicting cycle of
 *      form-order edges (only possible when several managers pull in opposite
 *      directions - contending for nothing, per rule d) breaks by seed.
 *
 * Deterministic for a given (bids, seed) regardless of input order.
 *
 * @param {Array<{managerId:number, playerId:number, amount:number, bidOrder:number,
 *                startRemaining:number}>} bids
 * @param {string} seed
 */
export function sortBids(bids, seed) {
  // Canonicalise input order so no trace of caller ordering survives.
  const canonical = [...bids].sort((a, b) => {
    const ra = seedRank(seed, a.managerId, a.playerId);
    const rb = seedRank(seed, b.managerId, b.playerId);
    return ra < rb ? -1 : ra > rb ? 1 : 0;
  });

  // Rule a: bands of equal amount, high to low.
  const byAmount = new Map();
  for (const b of canonical) {
    if (!byAmount.has(b.amount)) byAmount.set(b.amount, []);
    byAmount.get(b.amount).push(b);
  }
  const amounts = [...byAmount.keys()].sort((x, y) => y - x);

  const out = [];
  for (const amount of amounts) {
    const band = byAmount.get(amount);

    // Rule b: per-player groups, proportion (smaller purse) first, seed tie.
    const groups = new Map(); // playerId -> bids
    for (const b of band) {
      if (!groups.has(b.playerId)) groups.set(b.playerId, []);
      groups.get(b.playerId).push(b);
    }
    for (const g of groups.values()) {
      g.sort((a, b) => {
        const pa = a.startRemaining > 0 ? a.amount / a.startRemaining : Infinity;
        const pb = b.startRemaining > 0 ? b.amount / b.startRemaining : Infinity;
        if (pa !== pb) return pb - pa;
        const ra = seedRank(seed, a.managerId, a.playerId);
        const rb = seedRank(seed, b.managerId, b.playerId);
        return ra < rb ? -1 : 1;
      });
    }

    // Rule c: form-order edges between groups sharing a manager.
    const ids = [...groups.keys()];
    const groupSeed = new Map(ids.map((pid) => [pid, seedRank(seed, "player-group", pid)]));
    const after = new Map(ids.map((pid) => [pid, new Set()])); // pid -> groups that must come later
    const indegree = new Map(ids.map((pid) => [pid, 0]));
    const orderByManager = new Map(); // managerId -> [{pid, bidOrder}]
    for (const b of band) {
      if (!orderByManager.has(b.managerId)) orderByManager.set(b.managerId, []);
      orderByManager.get(b.managerId).push({ pid: b.playerId, bidOrder: b.bidOrder });
    }
    for (const entries of orderByManager.values()) {
      entries.sort((x, y) => x.bidOrder - y.bidOrder);
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          const from = entries[i].pid, to = entries[j].pid;
          if (from !== to && !after.get(from).has(to)) {
            after.get(from).add(to);
            indegree.set(to, indegree.get(to) + 1);
          }
        }
      }
    }

    // Seeded Kahn walk; a conflict cycle (rule d territory) breaks by seed.
    const remaining = new Set(ids);
    while (remaining.size > 0) {
      let pick = null;
      for (const pid of remaining) {
        if (indegree.get(pid) === 0 && (pick === null || groupSeed.get(pid) < groupSeed.get(pick))) {
          pick = pid;
        }
      }
      if (pick === null) {
        // Every remaining group is in a cycle: seed decides, drop its edges.
        for (const pid of remaining) {
          if (pick === null || groupSeed.get(pid) < groupSeed.get(pick)) pick = pid;
        }
      }
      remaining.delete(pick);
      for (const to of after.get(pick)) {
        if (remaining.has(to)) indegree.set(to, indegree.get(to) - 1);
      }
      out.push(...groups.get(pick));
    }
  }
  return out;
}

/**
 * The deterministic single-pass walk (spec 4.2 rule 3).
 *
 * @param {Object} args
 * @param {Array<{managerId: number, short: string, startRemaining: number,
 *   drops: Array<{playerId: number, position: string, priority: number}>,
 *   bids: Array<{playerId: number, position: string, amount: number,
 *                bidOrder: number, preTaken?: boolean}>
 * }>} args.forms   effective, RE-VALIDATED forms: drops still owned (with
 *                  their live positions), bids marked preTaken when the
 *                  target stopped being a free agent before the round.
 * @param {string} args.seed
 * @returns {{
 *   outcomes: Array<{sequence: number, managerId: number, playerId: number,
 *     position: string, amount: number,
 *     outcome: "won"|"player_taken"|"skipped_funds"|"skipped_position"|
 *              "skipped_capacity"|"lost_tie",
 *     price: number | null, droppedPlayerId: number | null,
 *     budgetAfter: number}>,
 *   managers: Array<{managerId: number, short: string, startRemaining: number,
 *     paid: number, endRemaining: number,
 *     wins: Array<{playerId: number, price: number, droppedPlayerId: number|null}>,
 *     released: number[], retained: number[]}>
 * }}
 */
export function computeResolution({ forms, seed }) {
  const budgets = new Map(forms.map((f) => [f.managerId, f.startRemaining]));
  // Per manager per position: total valid nominated slots, slots used, and
  // the not-yet-released nominated drops in priority order.
  const slots = new Map();
  for (const f of forms) {
    const byPos = new Map();
    for (const d of [...f.drops].sort((x, y) => x.priority - y.priority)) {
      if (!byPos.has(d.position)) byPos.set(d.position, { nominated: 0, used: 0, queue: [] });
      const cell = byPos.get(d.position);
      cell.nominated += 1;
      cell.queue.push(d.playerId);
    }
    slots.set(f.managerId, byPos);
  }

  const allBids = forms.flatMap((f) =>
    f.bids.map((b) => ({
      managerId: f.managerId,
      playerId: b.playerId,
      position: b.position,
      amount: b.amount,
      bidOrder: b.bidOrder,
      preTaken: b.preTaken === true,
      startRemaining: f.startRemaining,
    })),
  );
  const walk = sortBids(allBids, seed);

  /** @type {Map<number, {amount: number, managerId: number}>} */
  const awarded = new Map();
  const outcomes = [];
  const winsByManager = new Map(forms.map((f) => [f.managerId, []]));

  let sequence = 0;
  for (const bid of walk) {
    sequence += 1;
    const budget = budgets.get(bid.managerId) ?? 0;
    const cell = slots.get(bid.managerId)?.get(bid.position);
    let outcome;
    let price = null;
    let droppedPlayerId = null;

    if (bid.preTaken) {
      // The target stopped being a free agent before the round (spec 4.4
      // re-validation). The player is simply taken as far as this walk is
      // concerned.
      outcome = "player_taken";
    } else if (awarded.has(bid.playerId)) {
      // Taken THIS round: an equal-amount loser is a lost tie, anything
      // lower arrived after the hammer.
      outcome = awarded.get(bid.playerId).amount === bid.amount ? "lost_tie" : "player_taken";
    } else if (budget < bid.amount) {
      outcome = "skipped_funds"; // no funds spent, player stays available
    } else if (!cell || cell.nominated === 0) {
      outcome = "skipped_position"; // never nominated a drop of this position
    } else if (cell.used >= cell.nominated) {
      outcome = "skipped_capacity"; // slots existed but earlier wins consumed them
    } else {
      outcome = "won";
      price = bid.amount;
      budgets.set(bid.managerId, budget - bid.amount);
      cell.used += 1;
      droppedPlayerId = cell.queue.shift() ?? null;
      awarded.set(bid.playerId, { amount: bid.amount, managerId: bid.managerId });
      winsByManager.get(bid.managerId).push({ playerId: bid.playerId, price, droppedPlayerId });
    }

    outcomes.push({
      sequence,
      managerId: bid.managerId,
      playerId: bid.playerId,
      position: bid.position,
      amount: bid.amount,
      outcome,
      price,
      droppedPlayerId,
      budgetAfter: budgets.get(bid.managerId) ?? 0,
    });
  }

  const managers = forms.map((f) => {
    const wins = winsByManager.get(f.managerId) ?? [];
    const released = wins.map((w) => w.droppedPlayerId).filter((id) => id != null);
    const releasedSet = new Set(released);
    return {
      managerId: f.managerId,
      short: f.short,
      startRemaining: f.startRemaining,
      paid: wins.reduce((s, w) => s + w.price, 0),
      endRemaining: budgets.get(f.managerId) ?? f.startRemaining,
      wins,
      released,
      // Nominated drops whose slots were never consumed stay on the squad.
      retained: f.drops.map((d) => d.playerId).filter((id) => !releasedSet.has(id)),
    };
  });

  return { outcomes, managers };
}

/** @param {string} code @param {string} message */
function reject(code, message) {
  return { ok: false, code, message };
}

/**
 * Load the effective (latest before cutoff) forms for every active manager
 * and re-validate them against the true world state (spec 4.4): a nominated
 * drop must still be owned by its manager (else the slot evaporates); a bid
 * target must still be a free agent (else the bid is pre-taken).
 *
 * @param {import("postgres").TransactionSql} tx
 * @param {LeagueConfig} cfg
 * @param {{id: number, cutoff_at: Date | null}} period
 */
async function loadEffectiveForms(tx, cfg, period) {
  const managers = await tx`select id, slot, short from managers where sat_out = false order by slot`;
  const ctx = await loadOwnershipContext(tx);
  const ownership = resolveOwnership(ctx.sales, ctx.movements);
  const ownerByPlayer = new Map(ownership.map((o) => [o.playerId, o.managerId]));
  const positionByOwned = new Map(ownership.map((o) => [o.playerId, o.position]));
  const cash = tradeCashByManager(ctx.trades);
  const auction = auctionSpendByManager(ctx.spendRows);

  const forms = [];
  for (const m of managers) {
    const [sub] = await tx`
      select id, submitted_at from waiver_submissions
      where period_id = ${period.id} and manager_id = ${m.id}
        and (${period.cutoff_at ?? null}::timestamptz is null or submitted_at < ${period.cutoff_at})
      order by submitted_at desc, id desc
      limit 1
    `;
    if (!sub) continue; // no effective form: the manager sits the round out

    const [dropRows, bidRows] = await Promise.all([
      tx`
        select player_id, priority from waiver_drops
        where submission_id = ${sub.id} order by priority
      `,
      tx`
        select wb.player_id, wb.amount, wb.bid_order, p.position
        from waiver_bids wb join players p on p.id = wb.player_id
        where wb.submission_id = ${sub.id} order by wb.bid_order
      `,
    ]);

    // Drops re-validated against CURRENT ownership; position comes from the
    // live ownership row, never trusted from the form.
    const drops = dropRows
      .filter((d) => ownerByPlayer.get(d.player_id) === m.id)
      .map((d) => ({
        playerId: d.player_id,
        position: positionByOwned.get(d.player_id),
        priority: d.priority,
      }));
    const bids = bidRows.map((b) => ({
      playerId: b.player_id,
      position: b.position,
      amount: b.amount,
      bidOrder: b.bid_order,
      preTaken: ownerByPlayer.has(b.player_id),
    }));

    const owned = ownership.filter((o) => o.managerId === m.id);
    const derived = deriveManager(cfg, owned, cash[m.id] || 0, auction[m.id] || 0);
    forms.push({
      managerId: m.id,
      short: m.short,
      submissionId: sub.id,
      startRemaining: derived.remaining,
      drops,
      bids,
    });
  }
  return forms;
}

/**
 * Resolve the current waiver period. Commissioner-gated at the route.
 *
 * Dry-run: computes the full outcome from the live world and returns it
 * WITHOUT writing anything - no rows, no status change, no version bump.
 * The Commissioners rehearse with this before 26 Sep.
 *
 * Real run: requires the cutoff to have passed (or an explicit, audited
 * `force`), then applies everything in this ONE serialised transaction:
 *   waiver_results + waiver_outcomes; a sales row per win (stage = the
 *   period label); released flags + drops rows; audit rows; period closed;
 *   snapshot frozen (post-resolution state, including the outcome log);
 *   next period opened; app_state repointed; version bumped.
 *
 * @param {import("postgres").Sql} sql
 * @param {LeagueConfig} cfg
 * @param {{dryRun?: boolean, seed?: string, force?: boolean, actor?: string}} [opts]
 */
export async function resolveWaiverPeriod(sql, cfg, { dryRun = false, seed, force = false, actor = "commissioner" } = {}) {
  // Pre-write rule violations RETURN rejections (the transaction commits
  // nothing because nothing was written). Once the apply has started
  // writing, any failure THROWS instead: sql.begin only rolls back on a
  // throw, and a half-applied resolution must never commit.
  class ApplyError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }
  try {
    return await resolveInner();
  } catch (err) {
    if (err instanceof ApplyError) return reject(err.code, err.message);
    throw err;
  }

  async function resolveInner() {
  return await withAuctionLock(sql, async (tx, appState) => {
    if (!appState?.current_period_id) {
      return reject("no_period", "No current period is set; run the backfill first.");
    }
    const [period] = await tx`
      select id, seq, label, kind, season, status, cutoff_at
      from periods where id = ${appState.current_period_id}
    `;
    if (!period || period.kind !== "waiver") {
      return reject("not_waiver", "The current period is not a waiver period.");
    }
    if (period.status !== "open" && period.status !== "resolving") {
      return reject("bad_status", `${period.label} is ${period.status}; nothing to resolve.`);
    }
    const [{ now }] = await tx`select now() as now`;
    const cutoffPassed = period.cutoff_at != null && new Date(now) >= new Date(period.cutoff_at);
    if (!dryRun && !cutoffPassed && !force) {
      return reject(
        "before_cutoff",
        `${period.label} has not reached its cutoff yet. Use a dry run to rehearse, or force to resolve early (audited).`,
      );
    }
    // Double-resolution backstop #1 (structural #2 is UNIQUE(period_id)).
    const [already] = await tx`select id from waiver_results where period_id = ${period.id}`;
    if (already) {
      return reject("already_resolved", `${period.label} has already been resolved.`);
    }

    const forms = await loadEffectiveForms(tx, cfg, period);
    const finalSeed = seed ?? randomBytes(6).toString("hex");
    const result = computeResolution({ forms, seed: finalSeed });

    const summary = {
      period: { id: period.id, seq: period.seq, label: period.label },
      seed: finalSeed,
      formCount: forms.length,
      bidCount: result.outcomes.length,
      winCount: result.outcomes.filter((o) => o.outcome === "won").length,
      outcomes: result.outcomes,
      managers: result.managers,
    };

    if (dryRun) {
      return { ok: true, dryRun: true, applied: false, ...summary };
    }

    // ---- APPLY, all inside this one transaction --------------------------
    // From here on every failure THROWS (ApplyError) so the whole
    // transaction rolls back - never a partial resolution.
    if (period.status === "open") {
      const t = await transitionPeriod(tx, period.id, "resolving", actor);
      if (!t.ok) throw new ApplyError("transition_failed", t.message);
    }

    const [res] = await tx`
      insert into waiver_results (period_id, seed) values (${period.id}, ${finalSeed})
      returning id
    `;
    for (const o of result.outcomes) {
      await tx`
        insert into waiver_outcomes
          (result_id, sequence, manager_id, player_id, amount, outcome, price, dropped_player_id)
        values (${res.id}, ${o.sequence}, ${o.managerId}, ${o.playerId}, ${o.amount},
                ${o.outcome}, ${o.price}, ${o.droppedPlayerId})
      `;
    }

    // Wins and drops, in walk order. The sales insert preserves exclusive
    // ownership via the active-sale partial unique index; the released flag
    // is flipped in the same transaction as the drops row it denormalises.
    for (const o of result.outcomes) {
      if (o.outcome !== "won") continue;
      await tx`
        insert into sales (player_id, manager_id, price, stage, period_id)
        values (${o.playerId}, ${o.managerId}, ${o.price}, ${period.label}, ${period.id})
      `;
      if (o.droppedPlayerId != null) {
        await tx`
          update sales set released = true
          where player_id = ${o.droppedPlayerId} and released = false
        `;
        await tx`
          insert into drops (period_id, manager_id, player_id)
          values (${period.id}, ${o.managerId}, ${o.droppedPlayerId})
        `;
      }
      await tx`
        insert into audit_log (actor, action, entity, entity_id, after)
        values (${actor}, 'waiver.award', 'sales', ${o.playerId},
                ${tx.json({
                  periodId: period.id, managerId: o.managerId, playerId: o.playerId,
                  price: o.price, droppedPlayerId: o.droppedPlayerId,
                })})
      `;
    }

    await tx`
      insert into audit_log (actor, action, entity, entity_id, after)
      values (${actor}, 'waiver.resolve', 'periods', ${period.id},
              ${tx.json({
                seed: finalSeed, forms: summary.formCount,
                bids: summary.bidCount, wins: summary.winCount, forced: force && !cutoffPassed,
              })})
    `;

    // Close and archive THIS period (snapshot reflects the post-resolution
    // world and carries the full outcome log for the reveal replay).
    const t2 = await transitionPeriod(tx, period.id, "closed", actor);
    if (!t2.ok) throw new ApplyError("transition_failed", t2.message);
    const payload = await buildPeriodSnapshotPayload(tx, cfg, {
      id: period.id, seq: period.seq, label: period.label, kind: period.kind, season: period.season,
    });
    payload.waiver = { seed: finalSeed, outcomes: result.outcomes, managers: result.managers };
    const froze = await freezeSnapshot(tx, period.id, payload);
    if (!froze.ok) throw new ApplyError("snapshot_failed", froze.message);

    // Open the next period and point the app at it.
    const [next] = await tx`
      select id, label, status from periods where seq > ${period.seq} order by seq limit 1
    `;
    if (next && next.status === "locked") {
      const t3 = await transitionPeriod(tx, next.id, "open", actor);
      if (!t3.ok) throw new ApplyError("transition_failed", t3.message);
    }
    await tx`
      update app_state
      set current_period_id = ${next ? next.id : period.id}, version = version + 1
      where id = 1
    `;

    return { ok: true, dryRun: false, applied: true, nextPeriod: next ? next.label : null, ...summary };
  });
  }
}
