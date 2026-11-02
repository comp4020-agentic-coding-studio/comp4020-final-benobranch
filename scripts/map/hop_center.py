import json
import networkx as nx

d = json.load(open("scratch/act_edges_v5.json"))
nodes = {n["idx"]: n for n in d["nodes"]}
G = nx.Graph()
for i, n in nodes.items(): G.add_node(i, **n)
for e in d["edges"]: G.add_edge(e["a"], e["b"])
candidates = sorted(i for i, n in nodes.items() if not n["is_remainder"])
dist = {s: nx.single_source_shortest_path_length(G, s) for s in candidates}
idx_to_name = {i: n["name"] for i, n in nodes.items()}
name_to_idx = {n["name"]: i for i, n in nodes.items()}

# hop-center = node minimizing eccentricity (max hop distance to any other
# candidate suburb) -- robust to the city's elongated shape, unlike a
# geographic/projected centroid.
best = None
for c in candidates:
    ecc = max(dist[c][o] for o in candidates if o in dist[c])
    if best is None or ecc < best[1]:
        best = (c, ecc)
print("hop-center:", idx_to_name[best[0]], "eccentricity:", best[1])
print("City eccentricity for comparison:", max(dist[name_to_idx["City"]][o] for o in candidates if o in dist[name_to_idx["City"]]))

# distribution of hop distance from hop-center
from collections import Counter
hc = best[0]
cnt = Counter(dist[hc][o] for o in candidates if o in dist[hc])
for r in sorted(cnt):
    print(f"  R={r}: {cnt[r]} suburbs")
