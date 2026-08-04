"use client";

// Two-level phase navigation (docs/DESIGN-WAIVERS.md 2.1, mockup A). Mounted
// once in app/layout.tsx in place of RoomNav - RoomNav itself is untouched
// (another agent's file) and stays available for anything that still imports
// it directly.
//
// FALLBACK: pre-backfill (or on a fetch error) /api/periods reports an empty
// periods list. In that world this renders the exact markup RoomNav renders
// today (.room-nav / .room-navtab over ROOM_TABS), so the auction-era app is
// byte-identical until periods actually exist.
//
// Once periods exist, the top rail lists every phase in seq order, then
// Rules and History. Sub-tabs (Budget/Squads/Ledger/Trades/Charts) only show
// while a /phase/[seq] route is active.
//
// Phone: this component IS the one nav for /phase/* routes on every
// viewport (there is no separate phone variant to fork into - the sticky
// rail just keeps working at narrow widths). The exception is the three
// sub-routes that embed an unmodified legacy view (SquadsView/LedgerView/
// TradesView all mount their own fixed .ph-nav internally) - stacking this
// rail on top of that on a phone would double the nav, so this component
// hides itself under 640px on those three routes and lets the legacy
// PhoneNav (already inside those views) keep doing its job, exactly as it
// does on the old top-level /squads, /ledger, /trades routes.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Period } from "@/lib/periods";
import { ROOM_TABS } from "./tv-common";

function isHidden(pathname: string): boolean {
  return (
    pathname === "/console" ||
    pathname.startsWith("/console/") ||
    pathname === "/board/preview" ||
    pathname.startsWith("/board/preview/")
  );
}

const PHASE_ROUTE_RE = /^\/phase\/(\d+)(?:\/(.*))?$/;
// Sub-routes that render an unmodified legacy view (own internal PhoneNav) -
// see the "Phone" note above.
const LEGACY_EMBED_RE = /^\/phase\/\d+\/(squads|ledger|trades)(?:\/|$)/;

const SUB_TABS: { label: string; suffix: string }[] = [
  { label: "Budget", suffix: "" },
  { label: "Squads", suffix: "/squads" },
  { label: "Ledger", suffix: "/ledger" },
  { label: "Trades", suffix: "/trades" },
  { label: "Charts + Analysis", suffix: "/charts" },
];

/** Short month label for a phase tab's date line ("Sep"), or null. */
function shortMonth(iso: string | null): string | null {
  if (!iso) return null;
  try {
    return new Intl.DateTimeFormat("en-AU", { month: "short" }).format(new Date(iso));
  } catch {
    return null;
  }
}

export default function PhaseNav() {
  const pathname = usePathname();
  const [periods, setPeriods] = useState<Period[]>([]);
  const [currentPeriodId, setCurrentPeriodId] = useState<number | null>(null);
  const tabRefs = useRef<Map<number, HTMLAnchorElement>>(new Map());

  // Fetch once on mount, re-fetch on every route change (no 2s polling: the
  // phase list changes on lifecycle transitions, not many times a second).
  useEffect(() => {
    let disposed = false;
    fetch("/api/periods", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { periods?: Period[]; currentPeriodId?: number | null } | null) => {
        if (disposed || !data) return;
        setPeriods(data.periods ?? []);
        setCurrentPeriodId(data.currentPeriodId ?? null);
      })
      .catch(() => {
        // keep whatever was last loaded (or the empty fallback state)
      });
    return () => {
      disposed = true;
    };
  }, [pathname]);

  const phaseMatch = PHASE_ROUTE_RE.exec(pathname);
  const activeSeq = phaseMatch ? Number(phaseMatch[1]) : null;

  // Auto-scroll the active phase tab into view (mount + every route change).
  useEffect(() => {
    const seq = activeSeq ?? periods.find((p) => p.id === currentPeriodId)?.seq ?? null;
    if (seq == null) return;
    tabRefs.current.get(seq)?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [pathname, periods, activeSeq, currentPeriodId]);

  if (isHidden(pathname)) return null;

  // FALLBACK: no periods seeded yet - render RoomNav's exact markup so the
  // auction-era world renders unchanged.
  if (periods.length === 0) {
    return (
      <nav className="room-nav" aria-label="Room navigation">
        {ROOM_TABS.map((t) => {
          const active = pathname === t.href;
          return (
            <Link
              key={t.href}
              href={t.href}
              className={`room-navtab${active ? " active" : ""}`}
              aria-current={active ? "page" : undefined}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
    );
  }

  const isPhaseRoute = phaseMatch != null;
  const hideOnPhone = !isPhaseRoute || LEGACY_EMBED_RE.test(pathname);

  return (
    <nav
      className={`phase-nav${hideOnPhone ? " phase-nav--legacy" : ""}`}
      aria-label="Season phases"
    >
      <div className="phase-rail">
        {periods.map((p) => {
          const isCurrent = p.id === currentPeriodId;
          const locked = !isCurrent && p.status !== "closed";
          const active = activeSeq === p.seq;
          const dateLabel = shortMonth(p.cutoffAt ?? p.opensAt);
          return (
            <Link
              key={p.id}
              href={`/phase/${p.seq}`}
              ref={(el) => {
                if (el) tabRefs.current.set(p.seq, el);
                else tabRefs.current.delete(p.seq);
              }}
              className={`phase-tab${active ? " active" : ""}${locked ? " locked" : ""}`}
              aria-current={active ? "page" : undefined}
            >
              {isCurrent && <span className="live-dot" aria-hidden="true" />}
              {locked && (
                <span className="lock" aria-hidden="true">
                  &#128274;
                </span>
              )}
              <span>{p.label}</span>
              {dateLabel && <span className="phase-tab-date">{dateLabel}</span>}
            </Link>
          );
        })}
        <Link
          href="/rulebook"
          className={`phase-tab util${pathname === "/rulebook" ? " active" : ""}`}
        >
          Rules
        </Link>
        <Link href="/history" className={`phase-tab${pathname === "/history" ? " active" : ""}`}>
          History
        </Link>
      </div>

      {isPhaseRoute && activeSeq != null && (
        <div className="sub-rail">
          {SUB_TABS.map((t) => {
            const href = `/phase/${activeSeq}${t.suffix}`;
            const active = pathname === href;
            return (
              <Link key={t.suffix} href={href} className={`sub-tab${active ? " active" : ""}`}>
                {t.label}
              </Link>
            );
          })}
        </div>
      )}
    </nav>
  );
}
