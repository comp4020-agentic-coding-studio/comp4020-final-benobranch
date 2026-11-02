"""
Builds the suburb polygon geometry the GUI renders (ANU-010) — a thing
scripts/map/build_adjacency.py never needed, since that script only cares
about the adjacency graph, not what a suburb looks like.

Reuses build_adjacency.py's exact multipart-split logic (the ACT Remainder
tiles for Belconnen and Gungahlin each split into one node per disconnected
polygon piece) so this script's `sal_code`s land on the exact same 139 node
set scripts/map/data/map.json already has — a re-derived split that ordered
MultiPolygon parts differently would silently mislabel which geometry
belongs to which graph node, breaking the data-center/spawn name lookups
that join by name/sal_code across the two files.

Projects to EPSG:7855 (GDA2020 / MGA zone 55 — already used by
build_lobby_config.py for planar bearings) and topology-simplifies with the
`topojson` package rather than per-polygon Shapely simplification: a
per-polygon simplify independently wobbles each suburb's shared boundary,
reintroducing the gaps/overlaps PLAN.md's "Map data" section specifically
chose ABS SAL to avoid. Topology-preserving simplification keeps shared
edges between adjacent suburbs identical.

Output ships pre-flattened to SVG path strings (y-flipped so north is up,
in a plain top-left-origin SVG coordinate space) so the client needs no
projection or mapping library — consistent with PLAN.md's "fully static,
no live API calls" map-data decision and ANU-007's no-build-step, plain-ES-
module client.

Requires the raw ABS SAL suburb polygons (fetch_suburbs.py's output). Run
from the repo root with DATA_DIR pointing at that intermediate data:

    DATA_DIR=/path/to/map-raw python3 scripts/map/build_geometry.py \\
        > scripts/map/data/map-geometry.json
"""
import json
import os

import geopandas as gpd
import numpy as np
import topojson as tp

DATA_DIR = os.environ.get("DATA_DIR", "scratch")
SIMPLIFY_TOLERANCE = 50  # metres; see Notes below for why this value

gdf = gpd.read_file(os.path.join(DATA_DIR, "act_sal_raw.geojson"))
gdf = gdf[gdf.geometry.notna()].copy().reset_index(drop=True)
names = gdf["sal_name_2021"].values
codes = gdf["sal_code_2021"].values
is_remainder = np.array([n.startswith("ACT Remainder") for n in names])

# --- identical split logic to build_adjacency.py --- #
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

split_gdf = gpd.GeoDataFrame(
    {"sal_code": node_sal_code, "name": node_label, "is_remainder": node_is_remainder},
    geometry=node_geoms,
    crs=gdf.crs,
)
proj = split_gdf.to_crs(7855)

# Topology-preserving simplify: shared suburb boundaries stay identical
# (no new gaps/overlaps), unlike simplifying each polygon independently.
topo = tp.Topology(proj, prequantize=False)
simplified = topo.toposimplify(SIMPLIFY_TOLERANCE).to_gdf()
simplified["sal_code"] = proj["sal_code"].values
simplified["is_remainder"] = proj["is_remainder"].values

assert simplified.geometry.is_valid.all(), "simplification produced an invalid polygon"
sum_area = simplified.geometry.area.sum()
union_area = simplified.geometry.union_all().area
area_drift_pct = abs(sum_area - union_area) / sum_area * 100
assert area_drift_pct < 0.01, f"simplification introduced overlaps/gaps ({area_drift_pct:.4f}%)"

full_bounds = simplified.total_bounds  # minx, miny, maxx, maxy
urban_bounds = simplified[~simplified["is_remainder"]].total_bounds

# SVG has y increasing downward; projected northing increases upward. Flip
# by y' = maxY - y so north stays up without a transform in the client.
flip_y0 = full_bounds[3]


def polygon_to_path(geom) -> str:
    polys = list(geom.geoms) if geom.geom_type == "MultiPolygon" else [geom]
    subpaths = []
    for poly in polys:
        for ring in [poly.exterior, *poly.interiors]:
            coords = [(round(x, 1), round(flip_y0 - y, 1)) for x, y in ring.coords]
            d = f"M{coords[0][0]},{coords[0][1]}" + "".join(f"L{x},{y}" for x, y in coords[1:]) + "Z"
            subpaths.append(d)
    return " ".join(subpaths)


def polygon_label_point(geom):
    # representative_point (guaranteed inside the shape, unlike a plain
    # centroid on a concave polygon) for placing a data-center/spawn marker
    # that must land visibly on its suburb, not in open space beside it.
    p = geom.representative_point()
    return [round(p.x, 1), round(flip_y0 - p.y, 1)]


def bounds_to_view_box(b):
    minx, miny, maxx, maxy = b
    # flip y for the two y-bounds, then re-min/max since flipping swaps order
    y_top = flip_y0 - maxy
    y_bottom = flip_y0 - miny
    return {
        "x": round(minx, 1),
        "y": round(y_top, 1),
        "width": round(maxx - minx, 1),
        "height": round(y_bottom - y_top, 1),
    }


output = {
    "source_attribution": {
        "suburbs": "ABS ASGS Edition 3 (2021) Suburbs and Localities (SAL), CC BY 4.0, https://geo.abs.gov.au/arcgis/rest/services/ASGS2021/SAL/MapServer",
    },
    "projection": f"EPSG:7855 (GDA2020 / MGA zone 55), y-flipped for SVG, toposimplify tolerance {SIMPLIFY_TOLERANCE}m",
    "full_view_box": bounds_to_view_box(full_bounds),
    "urban_view_box": bounds_to_view_box(urban_bounds),
    "suburbs": [
        {
            "sal_code": row["sal_code"],
            "path": polygon_to_path(row.geometry),
            "label_point": polygon_label_point(row.geometry),
        }
        for _, row in simplified.iterrows()
    ],
}

print(json.dumps(output))
