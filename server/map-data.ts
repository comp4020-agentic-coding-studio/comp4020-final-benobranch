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

interface MapGeometry {
  suburbs: { sal_code: string; label_point: [number, number] }[];
}

const MAP_DATA_DIR = process.env.MAP_DATA_DIR ?? "scripts/map/data";

const mapData: MapData = JSON.parse(readFileSync(`${MAP_DATA_DIR}/map.json`, "utf8"));
// Same file the client fetches over /map/map-geometry.json (ANU-010) — read
// server-side too (ANU-038) so server/units.ts can compute real travel
// distance between two suburbs without duplicating the client's label-point
// data. Loaded once at module init, same static-reference-data reasoning as
// mapData above.
const mapGeometry: MapGeometry = JSON.parse(readFileSync(`${MAP_DATA_DIR}/map-geometry.json`, "utf8"));

export const validSalCodes = new Set(mapData.suburbs.map((s) => s.sal_code));
const nameToSalCode = new Map(mapData.suburbs.map((s) => [s.name, s.sal_code]));
const labelPointBySalCode = new Map(mapGeometry.suburbs.map((s) => [s.sal_code, s.label_point]));

// sal_code -> TFLOPS, built once from the same data_centers list, for
// server/tflops.ts's live per-player TFLOPS sum (ANU-019: TFLOPS is a
// speed multiplier derived from currently-held data centers, not a spent
// currency — see that issue's Resolution).
const dataCenterTflopsBySalCode = new Map(
  mapData.data_centers
    .map((dc) => [nameToSalCode.get(dc.name), dc.tflops] as const)
    .filter((entry): entry is [string, number] => entry[0] !== undefined),
);

export function getMapData(): MapData {
  return mapData;
}

/** sal_code -> TFLOPS for every data-center suburb; absent for a non-data-center suburb. */
export function getDataCenterTflopsBySalCode(): ReadonlyMap<string, number> {
  return dataCenterTflopsBySalCode;
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

/**
 * Straight-line distance (in the same map/SVG units as map-geometry.json's
 * label_point coordinates) between two suburbs' label points — the distance
 * server/units.ts's travel-time system divides by a unit type's `speed`.
 * Returns 0 for an unknown sal_code (validSalCodes.has is checked by every
 * caller first) rather than throwing, so a defensive caller degrades to an
 * instant move instead of crashing.
 */
export function distanceBetweenSalCodes(a: string, b: string): number {
  const pointA = labelPointBySalCode.get(a);
  const pointB = labelPointBySalCode.get(b);
  if (!pointA || !pointB) return 0;
  return Math.hypot(pointB[0] - pointA[0], pointB[1] - pointA[1]);
}
