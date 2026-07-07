// Typed wrapper: binds the pure sale transaction (lib/draft-core.mjs) to the
// app's shared postgres pool and league config. The /api/draft route is a
// thin wrapper over this; scripts/test-draft*.mjs drive draft-core directly
// with their own clients so the exact same transaction is what gets tested.

import { getConfig } from "./config";
import { sql } from "./db";
import { recordSale as recordSaleCore } from "./draft-core.mjs";

export interface SaleRejection {
  ok: false;
  /** Machine-readable rule name, e.g. "over_max_bid". */
  code: string;
  /** Plain-English rule + number, safe to show on the console. */
  message: string;
}

export interface SaleSuccess {
  ok: true;
  sale: {
    id: number;
    playerId: number;
    playerName: string;
    managerId: number;
    managerShort: string;
    price: number;
    lotNo: number | null;
    phase: number;
    createdAt: string;
  };
  /** sale.createdAt + revealMs: when clients should drop the reveal. */
  revealUntil: string;
}

export type SaleResult = SaleSuccess | SaleRejection;

/** Run the no-oversell sale transaction against the app's pool + config. */
export async function recordSale(args: {
  playerId: number;
  managerId: number;
  price: number;
  actor: string;
}): Promise<SaleResult> {
  return (await recordSaleCore(sql, getConfig(), args)) as SaleResult;
}
