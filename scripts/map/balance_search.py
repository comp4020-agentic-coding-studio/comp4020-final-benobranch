import json, itertools
import networkx as nx
import numpy as np
from collections import defaultdict

d = json.load(open("scratch/act_edges_v5.json"))
nodes = {n["idx"]: n for n in d["nodes"]}
G = nx.Graph()
for i, n in nodes.items(): G.add_node(i, **n)
for e in d["edges"]: G.add_edge(e["a"], e["b"])
candidates = sorted(i for i, n in nodes.items() if not n["is_remainder"])
dist = {s: nx.single_source_shortest_path_length(G, s) for s in candidates}
def hop(a, b): return dist[a].get(b)
name = lambda i: nodes[i]["name"]

MIN_SPAWN_SEP = 4
MIN_SPAWN_DC_SEP = 2
MIN_DC_SEP = 3
FLAVOUR_NAMES = {"Hume", "Fyshwick", "City", "Bruce (ACT)", "Mitchell (ACT)", "Symonston", "Pialligo", "Beard"}

def dc_sets(k):
    if k == 1:
        return [(c,) for c in candidates]
    out = []
    for combo in itertools.combinations(candidates, k):
        if min(hop(a,b) for a,b in itertools.combinations(combo,2)) >= MIN_DC_SEP:
            out.append(combo)
    return out

def best_subset_with_sep(members, n, min_sep):
    # exact search over small bucket, branch & bound on separation
    members = list(members)
    best = None
    def rec(start_i, chosen):
        nonlocal best
        if len(chosen) == n:
            seps = [hop(a,b) for a,b in itertools.combinations(chosen,2)]
            m = min(seps)
            if m >= min_sep and (best is None or m > best[0]):
                best = (m, tuple(chosen))
            return
        if start_i >= len(members):
            return
        # bound: not enough remaining to complete
        if len(members) - start_i < n - len(chosen):
            return
        for i in range(start_i, len(members)):
            c = members[i]
            if all(hop(c, ch) >= min_sep for ch in chosen):
                chosen.append(c)
                rec(i+1, chosen)
                chosen.pop()
    rec(0, [])
    return best

results = []
for K in (1, 2, 3):
    print(f"=== K={K} data centers ===")
    all_dc_sets = dc_sets(K)
    for N in (3, 4, 5, 6):
        strict_hits = []
        sym_hits = []
        for dcs in all_dc_sets:
            pool = [c for c in candidates if c not in dcs and all(hop(c, dc) >= MIN_SPAWN_DC_SEP for dc in dcs)]
            # bucket by exact distance vector and by sorted distance vector
            exact_buckets = defaultdict(list)
            sorted_buckets = defaultdict(list)
            for c in pool:
                vec = tuple(hop(c, dc) for dc in dcs)
                if any(v is None for v in vec):
                    continue
                exact_buckets[vec].append(c)
                sorted_buckets[tuple(sorted(vec))].append(c)
            for vec, members in exact_buckets.items():
                if len(members) >= N:
                    r = best_subset_with_sep(members, N, MIN_SPAWN_SEP)
                    if r:
                        strict_hits.append((r[0], dcs, r[1], vec))
            for vec, members in sorted_buckets.items():
                if len(members) >= N:
                    r = best_subset_with_sep(members, N, MIN_SPAWN_SEP)
                    if r:
                        sym_hits.append((r[0], dcs, r[1], vec))
        strict_hits.sort(key=lambda x: -x[0])
        sym_hits.sort(key=lambda x: -x[0])
        def flavour_count(dcs): return sum(1 for dc in dcs if name(dc) in FLAVOUR_NAMES)
        best_strict = max(strict_hits, key=lambda x: (x[0], flavour_count(x[1]))) if strict_hits else None
        best_sym = max(sym_hits, key=lambda x: (x[0], flavour_count(x[1]))) if sym_hits else None
        print(f" N={N}: strict-zero exists={bool(strict_hits)} (n={len(strict_hits)})  sym-zero exists={bool(sym_hits)} (n={len(sym_hits)})")
        if best_strict:
            sep, dcs, spawns, vec = best_strict
            print(f"   best STRICT: sep>={sep} dcs={[name(i) for i in dcs]} spawns={[name(i) for i in spawns]} dist_vec={vec} flavour={flavour_count(dcs)}")
        if best_sym:
            sep, dcs, spawns, vec = best_sym
            print(f"   best SYM:    sep>={sep} dcs={[name(i) for i in dcs]} spawns={[name(i) for i in spawns]} sorted_vec={vec} flavour={flavour_count(dcs)}")
        results.append({"K":K,"N":N,"best_strict": None if not best_strict else {"sep":best_strict[0],"dcs":[name(i) for i in best_strict[1]],"spawns":[name(i) for i in best_strict[2]],"vec":best_strict[3]}, "best_sym": None if not best_sym else {"sep":best_sym[0],"dcs":[name(i) for i in best_sym[1]],"spawns":[name(i) for i in best_sym[2]],"vec":best_sym[3]}})

json.dump(results, open("scratch/balance_search_results3.json","w"), indent=2)
