// Typed wrapper: binds the lot-engine transactions (lib/lot-core.mjs) to the
// app's shared postgres pool and league config. The /api/lot route is a thin
// wrapper over this; scripts/test-lot.mjs drives lot-core directly with its
// own client so the exact same transactions are what get tested.

import { getConfig } from "./config";
import { sql } from "./db";
import {
  buildQueue as buildQueueCore,
  endPhaseOne as endPhaseOneCore,
  noBid as noBidCore,
  nominate as nominateCore,
  pause as pauseCore,
  resume as resumeCore,
  setTv as setTvCore,
} from "./lot-core.mjs";

export interface LotRejection {
  ok: false;
  /** Machine-readable rule name, e.g. "not_your_turn", "already_paused". */
  code: string;
  /** Plain-English rule + number, safe to show on the console. */
  message: string;
}

export type LotResult<T = Record<string, never>> = ({ ok: true } & T) | LotRejection;

/** Build the phase-1 lot queue (frozen pool, zero sales required). */
export async function buildQueue(args: {
  actor: string;
}): Promise<LotResult<{ queue: number[]; firstPlayerId: number }>> {
  return (await buildQueueCore(sql, getConfig(), args)) as LotResult<{
    queue: number[];
    firstPlayerId: number;
  }>;
}

/** Mark the current lot NO BID and advance (phase 1) or clear the block (phase 2). */
export async function noBid(args: {
  actor: string;
}): Promise<
  LotResult<{ playerId: number; lotNo: number | null; nextPlayerId: number | null; phase: number }>
> {
  return (await noBidCore(sql, getConfig(), args)) as LotResult<{
    playerId: number;
    lotNo: number | null;
    nextPlayerId: number | null;
    phase: number;
  }>;
}

/** Pause the auction (TV shows the paused card). */
export async function pause(args: { actor: string }): Promise<LotResult> {
  return (await pauseCore(sql, args)) as LotResult;
}

/** Resume the auction (TV back to the block). */
export async function resume(args: { actor: string }): Promise<LotResult> {
  return (await resumeCore(sql, args)) as LotResult;
}

/** Console TV override; persists until changed. */
export async function setTv(args: {
  view: string;
  actor: string;
}): Promise<LotResult<{ view: string }>> {
  return (await setTvCore(sql, args)) as LotResult<{ view: string }>;
}

/** End phase one and seed the phase-2 nomination rotation. */
export async function endPhaseOne(args: {
  actor: string;
}): Promise<LotResult<{ nominationTurn: number }>> {
  return (await endPhaseOneCore(sql, getConfig(), args)) as LotResult<{
    nominationTurn: number;
  }>;
}

/** Phase-2 nomination (validates the fixed rotation turn). */
export async function nominate(args: {
  playerId: number;
  managerSlot: number;
  actor: string;
}): Promise<
  LotResult<{ playerId: number; lotNo: number; managerSlot: number; nominationTurn: number | null }>
> {
  return (await nominateCore(sql, getConfig(), args)) as LotResult<{
    playerId: number;
    lotNo: number;
    managerSlot: number;
    nominationTurn: number | null;
  }>;
}
