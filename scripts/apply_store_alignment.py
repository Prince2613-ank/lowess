import json
import math
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
BACKUP_DIR = BASE_DIR / "data" / "backup_geojson"

anchor_lat = 41.8140843218019
anchor_lon = -72.71526758866406
mpd_lat = 111320.0
mpd_lon = 111320.0 * math.cos(math.radians(anchor_lat))

# Calibration parameters verified against building footprint & satellite view:
e = 19.5
n = 15.5
rot = 180.0
sx = 0.980
sy = 0.970

theta = math.radians(rot)
cos_t = math.cos(theta)
sin_t = math.sin(theta)

def transform_coords(coords):
    if len(coords) == 2 and isinstance(coords[0], (int, float)) and isinstance(coords[1], (int, float)):
        lon, lat = coords
        le = (lon - anchor_lon) * mpd_lon * sx
        ln = (lat - anchor_lat) * mpd_lat * sy
        re = le * cos_t - ln * sin_t
        rn = le * sin_t + ln * cos_t
        fe = re + e
        fn = rn + n
        return [round(anchor_lon + fe / mpd_lon, 8), round(anchor_lat + fn / mpd_lat, 8)]
    return [transform_coords(c) for c in coords]

def transform_fc(fc):
    new_fc = json.loads(json.dumps(fc))
    for f in new_fc.get("features", []):
        if "geometry" in f and f["geometry"] and "coordinates" in f["geometry"]:
            f["geometry"]["coordinates"] = transform_coords(f["geometry"]["coordinates"])
    return new_fc

files = [
    "Lowes_depertment.geojson",
    "Lowes_depertment_line.geojson",
    "Lowes_depertment_point.geojson",
    "Lowes_aisle.geojson",
    "Lowes_aisle_line.geojson",
    "Lowes_aisle_point.geojson",
    "Lowes_rack.geojson",
    "Lowes_rack_line.geojson",
]

for fn in files:
    src_path = BACKUP_DIR / fn
    with open(src_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    transformed = transform_fc(data)
    dst_path = BASE_DIR / fn
    with open(dst_path, "w", encoding="utf-8") as f:
        json.dump(transformed, f)
    print(f"Wrote transformed {fn} ({len(transformed['features'])} features)")

print("All 8 GeoJSON files successfully updated!")
