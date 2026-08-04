"use client";

// The room - squads: fixes two auction-night bugs (docs/DESIGN-WAIVERS.md
// section 3F). Desktop/TV cards used to cap at 5 owned players with a
// "+N more" row; the TV canvas could measure a zero container width and
// commit to scale(0), blanking the whole screen. All three containers
// (desktop grid, phone stack, TV canvas) now share one SquadCard component
// that always renders the full squad from config-driven quotas, never a
// hardcoded 15.
//
// This route serves two real audiences at the same URL: a manager's laptop
// browser (the normal, unscaled 2-col grid, RoomNav visible) and the actual
// projector, which loads /squads?tv=1 to get the fixed 1600x900 canvas -
// the zero-width scale guard for that path lives in useBoardScale
// (tv-common.tsx) and is untouched here.

import { Suspense } from "react";
import type { CSSProperties } from "react";
import { useSearchParams } from "next/navigation";
import type { Position } from "@/lib/config";
import type { PlayerRow, PlayersManager, PlayersPayload } from "@/lib/players";
import SquadCard, { type SquadCardPlayer } from "./SquadCard";
import { PhoneNav, useBoardScale, useIsPhone, usePolledPlayers } from "./tv-common";

/** A manager's owned players, mapped to the plain shape SquadCard takes -
 * shared by every container so they all read the same rows. */
function ownedRows(m: PlayersManager, byId: Map<number, PlayerRow>): SquadCardPlayer[] {
  return m.squadPlayerIds
    .map((id) => byId.get(id))
    .filter((p): p is PlayerRow => p != null)
    .map((p) => ({
      id: p.id,
      position: p.position,
      displayName: p.displayName ?? p.name ?? "?",
      teamCode: p.teamCode,
      teamShort: p.teamShort,
      tier: p.tier,
      price: p.price,
      verdict: p.verdict,
    }));
}

// ---- Phone layout (plain reflowing HTML, not the scaled TV canvas) --------

function PhoneSquads({ payload, connected }: { payload: PlayersPayload | null; connected: boolean }) {
  const ready = payload !== null;
  const byId = new Map<number, PlayerRow>(payload ? payload.players.map((p) => [p.id, p]) : []);
  const totalManagers = payload?.managers.length ?? 0;
  const completeManagers = payload ? payload.managers.filter((m) => m.squadComplete).length : 0;
  const managers = payload ? [...payload.managers].sort((a, b) => a.slot - b.slot) : [];
  const squad = (payload?.squad ?? {}) as Record<Position, number>;

  return (
    <div className="ph-screen" data-testid="squads-page">
      <div className="ph-header">
        <span className="ph-eyebrow">THE ROOM / SQUADS</span>
        <span className="ph-headmeta">{ready ? `${completeManagers}/${totalManagers} COMPLETE` : ""}</span>
      </div>
      {!ready ? (
        <div className="ph-loading">{connected ? "connecting..." : "connection lost - retrying"}</div>
      ) : (
        <div className="ph-stack">
          {managers.map((m) => (
            <SquadCard
              key={m.slot}
              variant="phone"
              testId={`ph-squad-${m.slot}`}
              manager={m}
              players={ownedRows(m, byId)}
              squad={squad}
            />
          ))}
        </div>
      )}
      <PhoneNav />
    </div>
  );
}

// ---- Desktop grid (new, unscaled, normal document flow) --------------------

function DesktopGridSquads({ payload, connected }: { payload: PlayersPayload | null; connected: boolean }) {
  const ready = payload !== null;
  const byId = new Map<number, PlayerRow>(payload ? payload.players.map((p) => [p.id, p]) : []);
  const totalManagers = payload?.managers.length ?? 0;
  const completeManagers = payload ? payload.managers.filter((m) => m.squadComplete).length : 0;
  const managers = payload ? [...payload.managers].sort((a, b) => a.slot - b.slot) : [];
  const squad = (payload?.squad ?? {}) as Record<Position, number>;

  return (
    <main className="screen squads-grid-screen" data-testid="squads-page">
      <h1>Squads</h1>
      <p className="statusline">
        {ready ? `${completeManagers}/${totalManagers} squads complete` : connected ? "connecting..." : "connection lost - retrying"}
      </p>
      {ready && (
        <div className="squad-grid">
          {managers.map((m) => (
            <SquadCard
              key={m.slot}
              variant="grid"
              testId={`squads-manager-${m.slot}`}
              manager={m}
              players={ownedRows(m, byId)}
              squad={squad}
            />
          ))}
        </div>
      )}
    </main>
  );
}

// ---- TV canvas (fixed 1600x900, scaled to its frame) -----------------------

function TvSquads({ payload, connected }: { payload: PlayersPayload | null; connected: boolean }) {
  const { ref, scale } = useBoardScale();
  const ready = payload !== null && scale > 0;
  const byId = new Map<number, PlayerRow>(payload ? payload.players.map((p) => [p.id, p]) : []);
  const totalManagers = payload?.managers.length ?? 0;
  const completeManagers = payload ? payload.managers.filter((m) => m.squadComplete).length : 0;
  const allDone = totalManagers > 0 && completeManagers === totalManagers;
  const squad = (payload?.squad ?? {}) as Record<Position, number>;

  return (
    <div data-testid="squads-page">
      <div
        className={`board-frame${ready ? "" : " loading"}`}
        ref={ref}
        style={{ ["--board-scale" as string]: scale, height: ready ? 900 * scale : undefined } as CSSProperties}
      >
        {!ready ? (
          <div style={{ textAlign: "center" }}>
            <div className="kick" style={{ fontSize: 22 }}>The room - squads</div>
            <div style={{ margin: "10px 0" }}>{connected ? "connecting..." : "connection lost - retrying"}</div>
          </div>
        ) : (
          <div className="board-canvas squads">
            <div className="tv-top">
              <span className="kick">The room - squads</span>
              <span className="spacer" />
              <span className="meta">
                {allDone ? "DRAFT COMPLETE" : `${completeManagers}/${totalManagers} complete - live progress`}
              </span>
            </div>
            <div className="sqgrid">
              {payload!.managers.map((m) => (
                <SquadCard
                  key={m.slot}
                  variant="tv"
                  testId={`squads-manager-${m.slot}`}
                  manager={m}
                  players={ownedRows(m, byId)}
                  squad={squad}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// `?tv=1` selects the fixed 1600x900 projector canvas; otherwise a normal
// browser gets the unscaled 2-col grid. useSearchParams needs a Suspense
// boundary under the App Router even inside an all-client-component tree
// (same requirement as app/board/preview/page.tsx).
function SquadsViewInner({ tv: tvProp }: { tv?: boolean }) {
  const { payload, connected } = usePolledPlayers();
  const isPhone = useIsPhone();
  const searchParams = useSearchParams();
  // The board's TV handoff (app/page.tsx, tvView === "squads") passes tv as a
  // prop - the projector is on "/" with no query string there. The flag falls
  // back to ?tv=1 for a directly-loaded projector URL.
  const tv = tvProp ?? searchParams.get("tv") === "1";

  if (isPhone) return <PhoneSquads payload={payload} connected={connected} />;
  if (tv) return <TvSquads payload={payload} connected={connected} />;
  return <DesktopGridSquads payload={payload} connected={connected} />;
}

export default function SquadsView({ tv }: { tv?: boolean } = {}) {
  return (
    <Suspense fallback={<main className="screen">loading squads...</main>}>
      <SquadsViewInner tv={tv} />
    </Suspense>
  );
}
