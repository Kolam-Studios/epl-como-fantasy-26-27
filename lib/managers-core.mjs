// Manager administration (waiver era, mockup H item 2): the sit-out toggle.
// Owner ruling: a sat-out manager is out for the season - greyed in the
// console picker and board strip, skipped by the phase-2 nomination rotation
// (lot-core managerCompleteness) and excluded from the waiver form dropdown
// and the engine (both filter sat_out = false). Their frozen wallet row stays
// in every archive as the record. Untick to rejoin instantly.
//
// Plain JS with the client + config injected (repo -core convention).

import { withAuctionLock } from "./draft-core.mjs";

/** @param {string} code @param {string} message */
function reject(code, message) {
  return { ok: false, code, message };
}

/**
 * Set one manager's sat_out flag. Commissioner-gated at the route. Audited,
 * version-bumped (the board strip and form dropdown re-render on poll).
 *
 * @param {import("postgres").Sql} sql
 * @param {import("./config-core.mjs").LeagueConfig} cfg
 * @param {{managerId: number, satOut: boolean, actor: string}} args
 */
export async function setSatOut(sql, cfg, { managerId, satOut, actor }) {
  if (!Number.isInteger(managerId)) return reject("bad_manager", "managerId must be a whole number.");
  if (typeof satOut !== "boolean") return reject("bad_flag", "satOut must be true or false.");
  return await withAuctionLock(sql, async (tx, appState) => {
    if (!appState) {
      return reject("no_state", "The draft has not been initialised (app_state is empty). Run the seed first.");
    }
    const [mgr] = await tx`select id, slot, short, sat_out from managers where id = ${managerId}`;
    if (!mgr) return reject("unknown_manager", `No manager with id ${managerId} exists.`);
    if (mgr.sat_out === satOut) {
      return { ok: true, changed: false, managerId, slot: mgr.slot, satOut };
    }
    await tx`update managers set sat_out = ${satOut} where id = ${managerId}`;
    await tx`update app_state set version = version + 1 where id = 1`;
    await tx`
      insert into audit_log (actor, action, entity, entity_id, before, after)
      values (${actor}, 'manager.sit_out', 'managers', ${managerId},
              ${tx.json({ satOut: mgr.sat_out })}, ${tx.json({ satOut })})
    `;
    return { ok: true, changed: true, managerId, slot: mgr.slot, satOut };
  });
}
