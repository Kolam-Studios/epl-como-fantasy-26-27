"use client";

// Shared hook for the app/phase/[seq] routes: fetches /api/periods once
// (re-fetched whenever the requested seq changes) and returns the one period
// that matches, plus the full list (PhaseNav already has its own copy of the
// same fetch; this is a separate, page-scoped read so this file stays a tiny
// standalone hook rather than a shared store).

import { useEffect, useState } from "react";
import type { Period } from "@/lib/periods";

export interface UsePeriodResult {
  /** Every period, calendar order (empty pre-backfill or while loading). */
  periods: Period[];
  /** The period whose seq matches, or null once loaded with no match. */
  period: Period | null;
  currentPeriodId: number | null;
  loading: boolean;
}

export function usePeriod(seq: number): UsePeriodResult {
  const [periods, setPeriods] = useState<Period[]>([]);
  const [currentPeriodId, setCurrentPeriodId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    fetch("/api/periods", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { periods?: Period[]; currentPeriodId?: number | null } | null) => {
        if (disposed) return;
        setPeriods(data?.periods ?? []);
        setCurrentPeriodId(data?.currentPeriodId ?? null);
      })
      .catch(() => {
        if (!disposed) setPeriods([]);
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [seq]);

  const period = periods.find((p) => p.seq === seq) ?? null;
  return { periods, period, currentPeriodId, loading };
}
