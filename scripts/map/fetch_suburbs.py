import requests, json

url = "https://geo.abs.gov.au/arcgis/rest/services/ASGS2021/SAL/MapServer/0/query"
params = {
    "where": "state_code_2021='8'",
    "outFields": "sal_code_2021,sal_name_2021,state_code_2021,area_albers_sqkm",
    "f": "geojson",
    "outSR": "4326",
    "resultRecordCount": 2000,
}
r = requests.get(url, params=params, timeout=60)
r.raise_for_status()
d = r.json()
print("features:", len(d.get("features", [])))
with open("scratch/act_sal_raw.geojson", "w") as f:
    json.dump(d, f)
