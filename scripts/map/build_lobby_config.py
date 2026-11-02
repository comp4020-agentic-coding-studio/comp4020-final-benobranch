"""
Builds the baked lobby configuration: data center tiers/placement (fixed
across lobbies) and a spawn table for every lobby size 4-12 (player count
varies per lobby, per PLAN.md's lobby model).

Design, in order:

1. Data centers are fixed, tiered, and placed on real Canberra locations:
   - mega (5): City, Kingston, Fyshwick (user-specified real infrastructure/
     business suburbs) plus 2 of {Belconnen, Gungahlin, Phillip, Greenway} --
     geographic counterweights, chosen by search, so the mega tier isn't all
     clustered in one corner of the map.
   - major (10): the other 2 unused counterweights, plus 8 curated real
     Canberra town/group centres and business/industrial precincts (Weston,
     Dickson, Braddon, Bruce, Mitchell, Hume, Pialligo, Symonston) -- so
     every district has at least one strong data center, not just whichever
     2 suburbs a farthest-point search happens to pick.
   - standard (17): farthest-point sample of the remaining suburbs, for a
     32-total spread across the map.

2. Spawns are NOT part of the baked map data -- they're computed per lobby
   from its player count. The original "fan players N*(360/N) degrees
   around the map" idea doesn't work geometrically: Canberra's urban area is
   long north-south and only ~half as wide east-west, so literal equal-angle
   sectors leave some sectors (e.g. facing due east, which is the airport/
   NSW border) with no suburb in them at all. Fixed by spacing spawns evenly
   along a RING of suburbs at hop-distance 4-6 from the graph's hop-center
   (the suburb minimizing worst-case hop-eccentricity, found to be Acton),
   rather than by literal compass angle. This still reads as "spawns fanned
   around the outside of the map" to a player, it's just parameterized by
   the road graph's actual shape instead of raw lon/lat bearing.

3. Balance metric: NOT equidistance (multiple tiers of differing power make
   that meaningless -- being equidistant from a mega and a standard DC isn't
   "equal access"). Instead: soft access score per spawn = sum over all data
   centers of (tflops * 0.5^hop_distance), which rewards nearby AND powerful
   data centers and decays smoothly with distance. For each lobby size N,
   spawns are chosen (by rotating the start position around the ring) to
   minimize the max/min soft-access-score ratio across players, subject to a
   hard floor of >=2 hops pairwise separation between spawns.

Requires the raw ABS SAL suburb polygons and the road-adjacency graph built
by fetch_suburbs.py / fetch_roads.py / build_adjacency.py. Run from the repo
root with DATA_DIR pointing at that intermediate data:

    DATA_DIR=/path/to/map-raw/scratch python3 scripts/map/build_lobby_config.py \\
        > scripts/map/data/lobby_config.json
"""
import json
import math
import os
import itertools
import networkx as nx
import numpy as np
import geopandas as gpd

DATA_DIR = os.environ.get("DATA_DIR", "scratch")

d = json.load(open(os.path.join(DATA_DIR, "act_edges_v5.json")))
nodes = {n["idx"]: n for n in d["nodes"]}
G = nx.Graph()
for i, n in nodes.items():
    G.add_node(i, **n)
for e in d["edges"]:
    G.add_edge(e["a"], e["b"])
candidates = sorted(i for i, n in nodes.items() if not n["is_remainder"])
dist = {s: nx.single_source_shortest_path_length(G, s) for s in candidates}


def hop(a, b):
    return dist[a].get(b)


name_to_idx = {n["name"]: i for i, n in nodes.items()}
idx_to_name = {i: n["name"] for i, n in nodes.items()}

gdf = gpd.read_file(os.path.join(DATA_DIR, "act_sal_raw.geojson"))
gdf = gdf[gdf.geometry.notna()].reset_index(drop=True)
gdf_proj = gdf.to_crs(7855)  # GDA2020 / MGA zone 55 -- planar, for real bearings
name_to_centroid = {
    row["sal_name_2021"]: (row.geometry.centroid.x, row.geometry.centroid.y)
    for _, row in gdf_proj.iterrows()
}
node_xy = {}
for i in candidates:
    base_name = idx_to_name[i].split(" [part")[0]
    if base_name in name_to_centroid:
        node_xy[i] = name_to_centroid[base_name]
xs = [xy[0] for xy in node_xy.values()]
ys = [xy[1] for xy in node_xy.values()]
proj_center = (float(np.mean(xs)), float(np.mean(ys)))


def bearing(xy):
    dx = xy[0] - proj_center[0]
    dy = xy[1] - proj_center[1]
    return math.degrees(math.atan2(dx, dy)) % 360


def has_real_neighbor(i):
    return any(not nodes[nb]["is_remainder"] for nb in G.neighbors(i))


HOP_CENTER = name_to_idx["Acton (ACT)"]  # minimizes worst-case hop-eccentricity
dist_from_center = dist[HOP_CENTER]

USER_MEGA = ["City", "Kingston (ACT)", "Fyshwick"]
COUNTERWEIGHTS = ["Belconnen", "Gungahlin", "Phillip", "Greenway"]
PRECINCTS = [
    "Weston (ACT)", "Dickson", "Braddon", "Bruce (ACT)",
    "Mitchell (ACT)", "Hume", "Pialligo", "Symonston",
]

TOTAL_DC = 32
POWER = {"mega": 100, "major": 40, "standard": 15}
DECAY = 0.5  # soft-access-score decay per hop
MIN_SPAWN_SEP = 2
MIN_SPAWN_DC_SEP = 2
RING_R_LO, RING_R_HI = 4, 6  # see module docstring point 2


def soft_access_score(spawn, dcs, decay=DECAY):
    return sum(
        dc["tflops"] * (decay ** hop(spawn, dc["idx"]))
        for dc in dcs
        if hop(spawn, dc["idx"]) is not None
    )


def build_ring(exclude_hops_from, R_lo, R_hi, min_dc_sep):
    return [
        c for c in candidates
        if G.degree(c) >= 2
        and has_real_neighbor(c)
        and dist_from_center.get(c) is not None
        and R_lo <= dist_from_center[c] <= R_hi
        and all(hop(c, dc) >= min_dc_sep for dc in exclude_hops_from)
    ]


def space_evenly_ranked(ring, n, min_sep, dcs):
    """Among all rotations of n evenly-spaced picks around the ring (sorted
    by bearing), keep the rotation with: (1) pairwise hop separation >= the
    floor (hard reject below it), (2) lowest max/min soft-access ratio,
    (3) most even angular spacing as a tie-break."""
    ring_sorted = sorted(ring, key=lambda i: bearing(node_xy[i]))
    m = len(ring_sorted)
    if m < n:
        return None
    best = None
    for start in range(m):
        idxs = [ring_sorted[(start + round(k * m / n)) % m] for k in range(n)]
        if len(set(idxs)) != n:
            continue
        seps = [hop(a, b) for a, b in itertools.combinations(idxs, 2)]
        if any(s is None for s in seps):
            continue
        min_pairwise = min(seps)
        if min_pairwise < min_sep:
            continue
        scores = [soft_access_score(s, dcs) for s in idxs]
        if min(scores) <= 0:
            continue
        ratio = max(scores) / min(scores)
        bearings = sorted(bearing(node_xy[i]) for i in idxs)
        gaps = [(bearings[(k + 1) % n] - bearings[k]) % 360 for k in range(n)]
        evenness = float(np.var(gaps))
        cand = (ratio, evenness, idxs, scores, min_pairwise)
        if best is None or (cand[0], cand[1]) < (best[0], best[1]):
            best = cand
    return best


def farthest_sample(pool, k, exclude):
    pool = list(pool)
    if not pool or k <= 0:
        return []
    chosen = []
    remaining = set(pool)
    start = max(remaining, key=lambda c: min(hop(c, e) for e in exclude) if exclude else 0)
    chosen.append(start)
    remaining.discard(start)
    while len(chosen) < k and remaining:
        nxt = max(remaining, key=lambda c: min(hop(c, ch) for ch in (chosen + list(exclude))))
        chosen.append(nxt)
        remaining.discard(nxt)
    return chosen


def build_config(mega_pair):
    """mega_pair: which 2 of COUNTERWEIGHTS join USER_MEGA as mega tier.
    The other 2 counterweights fall back to major tier (not dropped
    entirely), so every one of the 4 geographic counterweight districts
    keeps at least a major-tier data center regardless of which pair wins."""
    mega_names = USER_MEGA + list(mega_pair)
    mega_idx = [name_to_idx[n] for n in mega_names]
    other_counterweights = [c for c in COUNTERWEIGHTS if c not in mega_pair]
    major_names = other_counterweights + PRECINCTS
    major_idx = [name_to_idx[n] for n in major_names]

    ring = build_ring(mega_idx + major_idx, RING_R_LO, RING_R_HI, MIN_SPAWN_DC_SEP)
    if len(ring) < 12:
        return None

    non_ring_pool = [c for c in candidates if c not in mega_idx and c not in major_idx and c not in ring]
    standard_count = TOTAL_DC - len(mega_idx) - len(major_idx)
    standard_idx = farthest_sample(non_ring_pool, standard_count, exclude=mega_idx + major_idx)

    dcs = (
        [{"idx": i, "tflops": POWER["mega"]} for i in mega_idx]
        + [{"idx": i, "tflops": POWER["major"]} for i in major_idx]
        + [{"idx": i, "tflops": POWER["standard"]} for i in standard_idx]
    )

    per_n = {}
    worst_ratio = 0
    for n in range(4, 13):
        r = space_evenly_ranked(ring, n, MIN_SPAWN_SEP, dcs)
        if r is None:
            return None
        ratio, _evenness, idxs, scores, min_pairwise = r
        worst_ratio = max(worst_ratio, ratio)
        per_n[n] = {
            "spawns": [idx_to_name[i] for i in idxs],
            "min_sep": min_pairwise,
            "ratio": round(ratio, 3),
            "scores": [round(s, 2) for s in scores],
        }
    return {
        "mega_names": mega_names, "major_idx": major_idx, "standard_idx": standard_idx,
        "dcs": dcs, "per_n": per_n, "ring_size": len(ring), "worst_ratio": worst_ratio,
    }


def main():
    best = None
    for pair in itertools.combinations(COUNTERWEIGHTS, 2):
        cfg = build_config(pair)
        if cfg is None:
            continue
        if best is None or cfg["worst_ratio"] < best["worst_ratio"]:
            best = cfg

    if best is None:
        raise SystemExit("no feasible configuration found")

    output = {
        "source_attribution": {
            "suburbs": "ABS ASGS Edition 3 (2021) Suburbs and Localities (SAL), CC BY 4.0, https://geo.abs.gov.au/arcgis/rest/services/ASGS2021/SAL/MapServer",
            "roads": "OpenStreetMap contributors, ODbL, via Overpass API",
        },
        "params": {
            "total_data_centers": TOTAL_DC, "power_by_tier": POWER,
            "soft_access_decay": DECAY, "min_spawn_separation_hops": MIN_SPAWN_SEP,
            "min_spawn_to_dc_separation_hops": MIN_SPAWN_DC_SEP,
            "spawn_ring_hop_band": [RING_R_LO, RING_R_HI], "hop_center_suburb": "Acton (ACT)",
        },
        "data_centers": [
            {"name": idx_to_name[dc["idx"]], "tier": (
                "mega" if dc["idx"] in [name_to_idx[n] for n in best["mega_names"]]
                else "major" if dc["idx"] in best["major_idx"] else "standard"
            ), "tflops": dc["tflops"]}
            for dc in best["dcs"]
        ],
        "spawn_table_by_lobby_size": best["per_n"],
        "worst_case_soft_access_ratio": round(best["worst_ratio"], 3),
    }
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
