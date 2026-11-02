import json
import geopandas as gpd
from shapely.geometry import Point
from shapely.strtree import STRtree
import numpy as np
import networkx as nx

gdf = gpd.read_file("scratch/act_sal_raw.geojson")
gdf = gdf[gdf.geometry.notna()].copy().reset_index(drop=True)
names = gdf["sal_name_2021"].values
codes = gdf["sal_code_2021"].values
is_remainder = np.array([n.startswith("ACT Remainder") for n in names])

# Split multipart remainder tiles into one node per disconnected polygon
# part (a scattered reserve tile isn't one contiguous corridor). Real
# suburbs stay single nodes. We do NOT drop or contract remainder nodes —
# PLAN.md's own reason for choosing ABS SAL is "no gaps/overlaps, every
# square metre belongs to exactly one tile"; dropping them reintroduces
# gaps. Remainder tiles stay in the graph as real (if low/no gameplay
# value) nodes, excluded only from spawn/data-center candidacy in the
# balance search itself.
node_geoms, node_label, node_sal_code, node_is_remainder = [], [], [], []

for i in range(len(gdf)):
    geom = gdf.geometry.iloc[i]
    if is_remainder[i]:
        parts = list(geom.geoms) if geom.geom_type == "MultiPolygon" else [geom]
        for p_i, part in enumerate(parts):
            node_geoms.append(part)
            node_label.append(f"{names[i]} [part {p_i}]" if len(parts) > 1 else names[i])
            node_sal_code.append(f"{codes[i]}-{p_i}" if len(parts) > 1 else str(codes[i]))
            node_is_remainder.append(True)
    else:
        node_geoms.append(geom)
        node_label.append(names[i])
        node_sal_code.append(str(codes[i]))
        node_is_remainder.append(False)

tree = STRtree(node_geoms)
TOL_DEG = 1e-5  # ~1m at this latitude; boundary snapping tolerance only

def locate(lon, lat):
    p = Point(lon, lat)
    cand_idx = tree.query(p)
    best_i, best_d = None, None
    for i in cand_idx:
        if node_geoms[i].intersects(p):
            return int(i)
        d = node_geoms[i].distance(p)
        if best_d is None or d < best_d:
            best_d, best_i = d, i
    if best_i is not None and best_d <= TOL_DEG:
        return int(best_i)
    return None  # outside ACT (e.g. NSW/Queanbeyan) — genuinely no tile

roads = json.load(open("scratch/act_roads_raw.json"))["elements"]

G = nx.Graph()
G.add_nodes_from(range(len(node_geoms)))

misses = 0
outside = 0
total_pts = 0
for way in roads:
    geom = way.get("geometry")
    if not geom or len(geom) < 2:
        continue
    seq = []
    for pt in geom:
        total_pts += 1
        idx = locate(pt["lon"], pt["lat"])
        if idx is None:
            outside += 1
            seq.append(None)  # break continuity — do NOT silently skip
            continue
        if not seq or seq[-1] != idx:
            seq.append(idx)
    for a, b in zip(seq, seq[1:]):
        if a is None or b is None or a == b:
            continue
        if G.has_edge(a, b):
            G[a][b]["weight"] += 1
        else:
            G.add_edge(a, b, weight=1)

print("total points:", total_pts, "outside ACT (break):", outside)
print("graph nodes:", G.number_of_nodes(), "edges:", G.number_of_edges())
print("connected components:", nx.number_connected_components(G))
comps = sorted(nx.connected_components(G), key=len, reverse=True)
for c in comps:
    print(" size", len(c), [node_label[i] for i in c] if len(c) < 15 else "(main)")

degs = sorted((G.degree(i), node_label[i]) for i in G.nodes)
print("lowest degree:", degs[:15])
print("highest degree:", degs[-10:])
import statistics
print("mean degree:", statistics.mean(dg for dg, _ in degs))

# spot checks
def deg_of(name):
    for i in G.nodes:
        if node_label[i] == name:
            return i, G.degree(i), [node_label[n] for n in G.neighbors(i)]
    return None

for nm in ["Hall", "Tharwa", "Uriarra Village", "Oaks Estate", "Denman Prospect", "Beard", "Fyshwick"]:
    r = deg_of(nm)
    print(nm, "->", r)

out = {
    "nodes": [
        {"idx": i, "sal_code": node_sal_code[i], "name": node_label[i], "is_remainder": node_is_remainder[i]}
        for i in G.nodes
    ],
    "edges": [
        {"a": a, "b": b, "weight": G[a][b]["weight"]}
        for a, b in G.edges
    ],
}
json.dump(out, open("scratch/act_edges_v5.json", "w"))
print("saved scratch/act_edges_v5.json")
