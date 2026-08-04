// Typed wrapper: binds the pure period-lifecycle assembly (lib/period-core.mjs)
// to the app's shared postgres pool and league config. app/api/periods and
// app/api/period/[seq] are thin wrappers over this, following the same
// pattern as lib/trades.ts over lib/trades-core.mjs.

import { getConfig } from "./config";
import { sql } from "./db";
import {
  getCurrentPeriod as getCurrentPeriodCore,
  getSnapshot as getSnapshotCore,
  listPeriods as listPeriodsCore,
} from "./period-core.mjs";

export type PeriodKind = "rebid" | "waiver";
export type PeriodStatus = "locked" | "open" | "resolving" | "closed";

/** One season phase (docs/DESIGN-WAIVERS.md 2.2): the August auction, each
 * monthly waiver, and the January rebid. */
export interface Period {
  id: number;
  seq: number;
  label: string;
  kind: PeriodKind;
  season: string;
  opensAt: string | null;
  cutoffAt: string | null;
  status: PeriodStatus;
  hasSnapshot: boolean;
}

export interface PeriodsPayload {
  /** Calendar (seq) order. */
  periods: Period[];
  /** null in the pre-waiver-era world where app_state.current_period_id is unset. */
  currentPeriodId: number | null;
  version: number;
  pollMs: number;
}

export interface PeriodSnapshot {
  /** The frozen archive payload (docs/DESIGN-WAIVERS.md section 5): budgets,
   * squads, ledger rows and that period's trades, written once at close. */
  payload: unknown;
  frozenAt: string;
}

export interface PeriodBySeqPayload {
  period: Period;
  snapshot: PeriodSnapshot | null;
}

/** Assemble the full /api/periods payload against the app's pool + config. */
export async function getPeriodsPayload(): Promise<PeriodsPayload> {
  const cfg = getConfig();
  const [periods, current, appStateRows] = await Promise.all([
    listPeriodsCore(sql) as Promise<Period[]>,
    getCurrentPeriodCore(sql) as Promise<Period | null>,
    sql`select version from app_state where id = 1`,
  ]);
  return {
    periods,
    currentPeriodId: current?.id ?? null,
    version: appStateRows[0] ? Number(appStateRows[0].version) : 0,
    pollMs: cfg.pollMs,
  };
}

/**
 * One period by its seq, with its frozen snapshot when the period is closed
 * and archived. Returns null when no period has this seq (the route maps
 * that to a 404).
 */
export async function getPeriodBySeq(seq: number): Promise<PeriodBySeqPayload | null> {
  const periods = (await listPeriodsCore(sql)) as Period[];
  const period = periods.find((p) => p.seq === seq) ?? null;
  if (!period) return null;
  const snapshot = period.hasSnapshot
    ? ((await getSnapshotCore(sql, period.id)) as PeriodSnapshot | null)
    : null;
  return { period, snapshot };
}
