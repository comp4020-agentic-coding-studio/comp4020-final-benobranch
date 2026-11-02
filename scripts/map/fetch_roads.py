import requests, json, time

BBOX = (-35.92053007, 148.7627901, -35.1244158, 149.39928704)

HIGHWAY_WHITELIST = [
    "motorway", "motorway_link",
    "trunk", "trunk_link",
    "primary", "primary_link",
    "secondary", "secondary_link",
    "tertiary", "tertiary_link",
    "unclassified",
    "residential",
    "living_street",
]

hw_regex = "|".join(HIGHWAY_WHITELIST)
query = f"""
[out:json][timeout:180];
(
  way["highway"~"^({hw_regex})$"]({BBOX[0]},{BBOX[1]},{BBOX[2]},{BBOX[3]});
);
out geom;
"""

headers = {
    "User-Agent": "comp4020-research-project/1.0 (ANU student project, non-commercial)",
    "Accept": "application/json",
}

ep = "https://overpass-api.de/api/interpreter"
t0 = time.time()
r = requests.post(ep, data={"data": query}, timeout=300, headers=headers)
print(time.time() - t0, r.status_code)
r.raise_for_status()
d = r.json()
print("ways:", len(d["elements"]))
with open("scratch/act_roads_raw.json", "w") as f:
    json.dump(d, f)
