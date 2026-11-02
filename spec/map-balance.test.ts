import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Checks the enforceable claim PLAN.md makes about spawn balance: this
// loads the SAME baked map data the server will serve and recomputes
// everything from scratch (BFS hop distances, soft-access scores) rather
// than trusting precomputed numbers in the file -- a stale or hand-edited
// "ratio" field in map.json would still be caught here.

type MapNode = { idx: number; sal_code: string | null; name: string; is_remainder: boolean };
type MapEdge = { a: number; b: number; weight: number };
type DataCenter = { name: string; tier: "mega" | "major" | "standard"; tflops: number };
type SpawnEntry = { spawns: string[]; min_sep: number; ratio: number; scores: number[] };

type MapData = {
  suburbs: MapNode[];
  edges: MapEdge[];
  params: {
    total_data_centers: number;
    power_by_tier: Record<string, number>;
    soft_access_decay: number;
    min_spawn_separation_hops: number;
    min_spawn_to_dc_separation_hops: number;
  };
  data_centers: DataCenter[];
  spawn_table_by_lobby_size: Record<string, SpawnEntry>;
  worst_case_soft_access_ratio: number;
};

const map: MapData = JSON.parse(readFileSync("scripts/map/data/map.json", "utf8"));

const nameToIdx = new Map(map.suburbs.map((s) => [s.name, s.idx]));

// Adjacency list, for BFS -- recomputed here, independent of anything the
// baking script stored.
const adjacency = new Map<number, number[]>();
for (const s of map.suburbs) adjacency.set(s.idx, []);
for (const e of map.edges) {
  adjacency.get(e.a)!.push(e.b);
  adjacency.get(e.b)!.push(e.a);
}

function bfsDistances(start: number): Map<number, number> {
  const dist = new Map<number, number>([[start, 0]]);
  const queue = [start];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    for (const next of adjacency.get(cur) ?? []) {
      if (!dist.has(next)) {
        dist.set(next, dist.get(cur)! + 1);
        queue.push(next);
      }
    }
  }
  return dist;
}

function softAccessScore(spawnIdx: number, decay: number): number {
  const dist = bfsDistances(spawnIdx);
  let total = 0;
  for (const dc of map.data_centers) {
    const dcIdx = nameToIdx.get(dc.name);
    if (dcIdx === undefined) continue;
    const hops = dist.get(dcIdx);
    if (hops === undefined) continue;
    total += dc.tflops * decay ** hops;
  }
  return total;
}

describe("map graph", () => {
  it("has exactly one connected component covering every suburb", () => {
    const allIdx = map.suburbs.map((s) => s.idx);
    const reached = bfsDistances(allIdx[0]);
    for (const idx of allIdx) {
      expect(reached.has(idx), `suburb idx ${idx} unreachable from suburb 0`).toBe(true);
    }
  });

  it("has the declared number of data centers, all resolving to real suburbs", () => {
    expect(map.data_centers).toHaveLength(map.params.total_data_centers);
    for (const dc of map.data_centers) {
      expect(nameToIdx.has(dc.name), `data center "${dc.name}" not found in suburb list`).toBe(true);
    }
  });

  it("places no data center on a remainder (wilderness) tile", () => {
    const remainderNames = new Set(map.suburbs.filter((s) => s.is_remainder).map((s) => s.name));
    for (const dc of map.data_centers) {
      expect(remainderNames.has(dc.name), `data center "${dc.name}" sits on a wilderness tile`).toBe(false);
    }
  });
});

describe("spawn balance (per lobby size 4-12)", () => {
  for (const [lobbySize, entry] of Object.entries(map.spawn_table_by_lobby_size)) {
    const n = Number(lobbySize);

    it(`N=${n}: has exactly ${n} distinct spawns`, () => {
      expect(entry.spawns).toHaveLength(n);
      expect(new Set(entry.spawns).size).toBe(n);
    });

    it(`N=${n}: every spawn is >= ${map.params.min_spawn_separation_hops} hops from every other spawn`, () => {
      const idxs = entry.spawns.map((name) => nameToIdx.get(name)!);
      for (let i = 0; i < idxs.length; i++) {
        const dist = bfsDistances(idxs[i]);
        for (let j = i + 1; j < idxs.length; j++) {
          const hops = dist.get(idxs[j]);
          expect(hops, `${entry.spawns[i]} <-> ${entry.spawns[j]}`).toBeDefined();
          expect(hops!).toBeGreaterThanOrEqual(map.params.min_spawn_separation_hops);
        }
      }
    });

    it(`N=${n}: recomputed soft-access ratio matches the baked value`, () => {
      const idxs = entry.spawns.map((name) => nameToIdx.get(name)!);
      const scores = idxs.map((idx) => softAccessScore(idx, map.params.soft_access_decay));
      const ratio = Math.max(...scores) / Math.min(...scores);
      expect(ratio).toBeCloseTo(entry.ratio, 1);
    });

    it(`N=${n}: no spawn's power access exceeds the agreed worst-case bound`, () => {
      const idxs = entry.spawns.map((name) => nameToIdx.get(name)!);
      const scores = idxs.map((idx) => softAccessScore(idx, map.params.soft_access_decay));
      const ratio = Math.max(...scores) / Math.min(...scores);
      // Bound agreed with the user: worst case across all lobby sizes is
      // ~2.7x (see PLAN.md's "Players & spawn balance" verdict); allow a
      // small margin above the measured worst case rather than hand-coding
      // today's exact float.
      expect(ratio).toBeLessThanOrEqual(3.0);
    });
  }
});
