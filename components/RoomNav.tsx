"use client";

// Desktop/browser tab bar (#62), the companion to the phone's PhoneNav. Mounted
// once in app/layout.tsx above {children}, so every route picks it up without a
// per-view edit. It is a STICKY, normal-flow bar (not fixed): it reserves its
// own height at the top of the document, so it never overlaps the scaled 1600x900
// board/squads/ledger canvases and introduces no post-hydration layout shift.
//
// The phone still uses PhoneNav; this bar is hidden below the phone breakpoint
// purely in CSS (.room-nav display:none under 640px), so there is no double nav
// and no render flash - no JS width check needed.
//
// Hidden on the operator console and the /board/preview verification aid: those
// are not room-facing viewer pages. Every other route (board, squads, ledger,
// trades, rulebook, manager, recap, player detail) shows it.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ROOM_TABS } from "./tv-common";

function isHidden(pathname: string): boolean {
  return (
    pathname === "/console" ||
    pathname.startsWith("/console/") ||
    pathname === "/board/preview" ||
    pathname.startsWith("/board/preview/")
  );
}

export default function RoomNav() {
  const pathname = usePathname();
  if (isHidden(pathname)) return null;
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
