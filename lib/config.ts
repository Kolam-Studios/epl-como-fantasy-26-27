import config from "@/league.config.json";

export type Position = "GK" | "DEF" | "MID" | "FWD";

export interface LeagueConfig {
  season: string;
  sport: string;
  managers: string[];
  budget: number;
  squad: Record<Position, number>;
  bidFloor: number;
  increment: number | null;
  multipick: boolean;
  rebidRounds: number;
  scoringSource: string;
}

export const league = config as unknown as LeagueConfig;

export const SQUAD_SIZE = (Object.values(league.squad) as number[]).reduce(
  (a, b) => a + b,
  0,
);

// FPL element_type -> our position code
export const FPL_POSITION: Record<number, Position> = {
  1: "GK",
  2: "DEF",
  3: "MID",
  4: "FWD",
};
