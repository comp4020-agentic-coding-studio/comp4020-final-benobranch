// Server-side read of the same baked map.json the client fetches over HTTP
// (server/index.ts's /map/map.json route, ANU-006) — loaded once at module
// init since it's static reference data for the whole process lifetime, not
// per-request state. Used by territory.ts (spawn-ownership-at-kickoff) and
// units.ts (occupancy validation: a sal_code must name a real suburb).
import { readFileSync } from "node:fs";

export interface MapSuburb {
  idx: number;
  sal_code: string;
  name: string;
  is_remainder: boolean;
}

export interface SpawnEntry {
  spawns: string[];
  min_sep: number;
  ratio: number;
  scores: number[];
}

export interface MapData {
  suburbs: MapSuburb[];
  edges: { a: number; b: number; weight: number }[];
  data_centers: { name: string; tier: "mega" | "major" | "standard"; tflops: number }[];
  spawn_table_by_lobby_size: Record<string, SpawnEntry>;
}

const MAP_DATA_DIR = process.env.MAP_DATA_DIR ?? "scripts/map/data";

const mapData: MapData = JSON.parse(readFileSync(`${MAP_DATA_DIR}/map.json`, "utf8"));

export const validSalCodes = new Set(mapData.suburbs.map((s) => s.sal_code));
const nameToSalCode = new Map(mapData.suburbs.map((s) => [s.name, s.sal_code]));

export function getMapData(): MapData {
  return mapData;
}

/** Spawn suburbs for a given lobby capacity, by sal_code (not display name) — null if no table entry for that size. */
export function spawnSalCodesForCapacity(capacity: number): string[] | null {
  const entry = mapData.spawn_table_by_lobby_size[String(capacity)];
  if (!entry) return null;
  const codes: string[] = [];
  for (const name of entry.spawns) {
    const code = nameToSalCode.get(name);
    if (code) codes.push(code);
  }
  return codes;
}
