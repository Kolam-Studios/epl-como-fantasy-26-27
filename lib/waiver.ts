// Typed wrapper: binds the waiver form cores (lib/waiver-core.mjs) to the
// app's shared pool and config. The /api/waiver* routes are thin wrappers;
// scripts/test-waiver-form.mjs drives waiver-core directly with its own
// client so the exact same validation and writes are what gets tested.

import { getConfig } from "./config";
import { sql } from "./db";
import {
  submitWaiverForm as submitCore,
  waiverContext as contextCore,
  tokenHistory as historyCore,
} from "./waiver-core.mjs";

export interface WaiverRejection {
  ok: false;
  code: string;
  message: string;
}

export async function submitWaiverForm(args: {
  managerId: number;
  token: string;
  drops: Array<{ playerId: number }>;
  bids: Array<{ playerId: number; amount: number }>;
  actor?: string;
}): Promise<Record<string, unknown>> {
  return (await submitCore(sql, getConfig(), args)) as Record<string, unknown>;
}

export async function waiverContext(args: {
  managerId: number;
  token: string;
}): Promise<Record<string, unknown>> {
  return (await contextCore(sql, getConfig(), args)) as Record<string, unknown>;
}

export async function tokenHistory(token: string): Promise<Record<string, unknown>> {
  return (await historyCore(sql, token)) as Record<string, unknown>;
}
