"""Generate SIMULATED rack inventory for the store maps (not live data).

For every store under ``stores/<id>/`` this gives every shelf bay in the
``Lowes_rack`` MultiPolygon a simulated inventory record and writes
``frontend/data/inventory/<id>.json``. Nothing here touches the map GeoJSON:
each rack record points at its bay by ``geometry_ref`` (feature index +
polygon part index) and carries the bay's source centroid so the frontend can
verify the link. Slivers under 0.05 m2 (drawing artefacts) are skipped.

Associations are derived spatially. The department is only kept when
unambiguous (otherwise "Unassigned"); the aisle falls back step by step:

* Department - the smallest department polygon part containing the bay that
  carries exactly one department label. A part holding several different
  labels is used only when one label is clearly the nearest (< 0.6x the
  distance of the next).
* Aisle - the bay's open (customer-facing) long side looks onto a walkway; the
  aisle is the one numbered label standing in that walkway with an unblocked
  line of sight along it (``aisle_source: "walkway"``). Otherwise the nearest
  numbered label within 12 m that no other bay hides from the bay
  (``"nearest"``). Bays with neither get a ``location`` instead: the nearest
  named area label within 30 m (e.g. "Back Wall", "Garden Center"), else
  their department.

Usage:  python scripts/generate_inventory.py [--stores 1665,2544]
"""
from __future__ import annotations

import argparse
import json
import math
import random
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

from shapely import STRtree
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import nearest_points

ROOT = Path(__file__).resolve().parents[1]
STORES_DIR = ROOT / "stores"
OUTPUT_DIR = ROOT / "frontend" / "data" / "inventory"
MIN_RACK_AREA = 0.05  # m2
UNASSIGNED = "Unassigned"
AISLE_LABEL = re.compile(r"^(\d+|GC\d+)$")
NEAREST_AISLE_RADIUS = 12.0  # m
AREA_LABEL_RADIUS = 30.0     # m

# Department label -> product category.
DEPARTMENT_CATEGORIES = {
    "TOOLS": ("Power Tools", "Hand Tools"),
    "PAINT": ("Paint & Supplies",),
    "ROUGH ELECTRICAL": ("Electrical",),
    "LIGHTING": ("Electrical",),
    "ELECTRICAL": ("Electrical",),
    "ROUGH PLUMBING": ("Plumbing",),
    "FASHION PLUMBING": ("Plumbing",),
    "PLUMBING": ("Plumbing",),
    "HARDWARE": ("Hardware",),
    "BUILDING MATERIALS": ("Building Materials",),
    "LUMBER": ("Building Materials",),
    "MILLWORK": ("Building Materials",),
    "FLOORING": ("Flooring",),
    "STORAGE": ("Storage",),
    "INSIDE LAWN AND GARDEN": ("Lawn & Garden",),
    "OUTSIDE LAWN AND GARDEN": ("Lawn & Garden",),
    "GARDEN CENTER": ("Lawn & Garden",),
    "OUTDOOR POWER EQUIPMENT": ("Lawn & Garden",),
    "APPLIANCES": ("Appliances",),
    "HOME DECOR": ("Home Decor",),
    "CABINETS": ("Kitchen & Cabinets",),
    "CLEANING": ("Cleaning Supplies",),
}
DEFAULT_CATEGORY = "General Merchandise"

# Generic product descriptions: (name, units that fit in one capacity slot).
PRODUCTS = {
    "Power Tools": [("20V Cordless Drill/Driver Kit", 4), ("7-1/4 in Circular Saw", 3), ("Random Orbit Sander", 6),
                    ("Brushless Impact Driver", 5), ("Oscillating Multi-Tool", 6), ("Reciprocating Saw Kit", 3)],
    "Hand Tools": [("16 oz Claw Hammer", 12), ("25 ft Tape Measure", 30), ("Screwdriver Set (10-Piece)", 10),
                   ("Adjustable Wrench Set", 10), ("Utility Knife", 40), ("Locking Pliers", 20)],
    "Paint & Supplies": [("Interior Eggshell Paint, 1 gal", 4), ("Exterior Satin Paint, 1 gal", 4), ("9 in Roller Kit", 12),
                         ("2 in Angled Sash Brush", 30), ("Painter's Tape 1.88 in", 24), ("Canvas Drop Cloth 9x12", 8)],
    "Electrical": [("14/2 NM-B Wire, 50 ft", 4), ("15A Duplex Outlet (10-Pack)", 12), ("Single-Pole Light Switch", 30),
                   ("LED A19 Bulb (4-Pack)", 16), ("Plastic Electrical Box", 40), ("Wire Connectors (100-Pack)", 30)],
    "Plumbing": [("1/2 in PEX Pipe, 100 ft", 2), ("PVC 90-Degree Elbow (10-Pack)", 15), ("Single-Handle Kitchen Faucet", 3),
                 ("Toilet Fill Valve", 12), ("Ball Valve 3/4 in", 20), ("Thread Seal Tape", 60)],
    "Hardware": [("Deck Screws #8 x 2-1/2 in, 5 lb", 8), ("Cabinet Hinges (2-Pack)", 30), ("Wall Anchors Kit", 25),
                 ("Zinc Hex Bolts (25-Pack)", 30), ("Heavy-Duty Shelf Bracket", 20), ("Door Stop (4-Pack)", 30)],
    "Building Materials": [("2x4x8 Stud Lumber", 6), ("1/2 in Drywall 4x8 Sheet", 2), ("Concrete Mix, 80 lb", 1),
                           ("Construction Adhesive, 10 oz", 24), ("Joint Compound, 4.5 gal", 2), ("OSB Sheathing 7/16 in", 2)],
    "Flooring": [("Luxury Vinyl Plank, 20 sq ft", 3), ("Laminate Flooring, 22 sq ft", 3), ("Porcelain Tile 12x24 (Case)", 2),
                 ("Foam Underlayment Roll", 4), ("Tile Spacers (200-Pack)", 40), ("Grout, 10 lb", 6)],
    "Storage": [("5-Tier Steel Shelving Unit", 1), ("27 gal Storage Tote", 3), ("Wall-Mounted Tool Rack", 6),
                ("Drawer Organizer Set", 12), ("Garage Hook Kit", 10), ("Stackable Storage Bin", 8)],
    "Lawn & Garden": [("Garden Soil, 1 cu ft", 2), ("Mulch, 2 cu ft", 2), ("50 ft Garden Hose", 4),
                      ("Pruning Shears", 20), ("Lawn Fertilizer, 15 lb", 3), ("Steel Garden Rake", 5)],
    "Appliances": [("Countertop Microwave, 1.1 cu ft", 1), ("Water Filter Cartridge", 12), ("Dryer Vent Kit", 8),
                   ("Dishwasher Installation Kit", 10), ("Refrigerator Water Line, 10 ft", 15), ("Range Cord, 4-Wire", 10)],
    "Home Decor": [("Area Rug, 5x7", 2), ("Wall Mirror, 24x36", 2), ("Decorative Throw Pillow", 10),
                   ("Blackout Curtain Panel", 8), ("Ceramic Planter, 10 in", 6), ("Picture Frame Set", 8)],
    "Kitchen & Cabinets": [("Base Cabinet, 24 in", 1), ("Wall Cabinet, 30 in", 1), ("Cabinet Pull (10-Pack)", 20),
                           ("Soft-Close Drawer Slides", 12), ("Shelf Liner Roll", 20), ("Lazy Susan Turntable", 6)],
    "Cleaning Supplies": [("All-Purpose Cleaner, 32 oz", 24), ("Microfiber Cloths (12-Pack)", 20), ("Push Broom, 24 in", 4),
                          ("Shop Vacuum Filter", 10), ("Mop and Bucket Set", 2), ("Trash Bags, 30 gal (50 ct)", 12)],
    "General Merchandise": [("Batteries AA (24-Pack)", 30), ("Work Gloves (3-Pack)", 24), ("Extension Cord, 25 ft", 10),
                            ("LED Flashlight", 20), ("Duct Tape, 60 yd", 24), ("Safety Glasses", 30)],
}
CATEGORY_CODES = {"Power Tools": "PT", "Hand Tools": "HT", "Paint & Supplies": "PS", "Electrical": "EL", "Plumbing": "PL",
                  "Hardware": "HW", "Building Materials": "BM", "Flooring": "FL", "Storage": "ST", "Lawn & Garden": "LG",
                  "Appliances": "AP", "Home Decor": "HD", "Kitchen & Cabinets": "KC", "Cleaning Supplies": "CL",
                  "General Merchandise": "GM"}


class LocalProjection:
    """Equirectangular metres around the store; plenty for a few hundred metres."""

    def __init__(self, lon0: float, lat0: float):
        self.lon0, self.lat0 = lon0, lat0
        self.kx = 111_320 * math.cos(math.radians(lat0))
        self.ky = 110_574

    def xy(self, lon: float, lat: float) -> tuple[float, float]:
        return (lon - self.lon0) * self.kx, (lat - self.lat0) * self.ky

    def polygon(self, rings) -> Polygon:
        project = lambda ring: [self.xy(p[0], p[1]) for p in ring]
        return Polygon(project(rings[0]), [project(r) for r in rings[1:]])


def load(store_dir: Path, name: str) -> list[dict]:
    path = store_dir / f"{name}.geojson"
    return json.loads(path.read_text(encoding="utf-8"))["features"] if path.is_file() else []


def polygon_parts(features):
    """Yield (feature_index, part_index, rings) for every polygon in the features."""
    for fi, feature in enumerate(features):
        geometry = feature.get("geometry") or {}
        if geometry.get("type") == "Polygon":
            yield fi, 0, geometry["coordinates"]
        elif geometry.get("type") == "MultiPolygon":
            for pi, rings in enumerate(geometry["coordinates"]):
                yield fi, pi, rings


def ring_centroid(rings) -> list[float]:
    """Shoelace centroid of the outer ring in source (lon/lat) coordinates.

    Computed relative to the first vertex to avoid cancellation with large
    absolute coordinates; frontend/inventory.js uses the same formula.
    """
    ring = rings[0]
    ox, oy = ring[0][0], ring[0][1]
    area = cx = cy = 0.0
    for (x0, y0, *_), (x1, y1, *_) in zip(ring, ring[1:]):
        x0, y0, x1, y1 = x0 - ox, y0 - oy, x1 - ox, y1 - oy
        cross = x0 * y1 - x1 * y0
        area += cross
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    if area == 0:
        return [sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring)]
    return [ox + cx / (3 * area), oy + cy / (3 * area)]


def rect_axes(poly: Polygon):
    """Long-axis unit vector u, short-axis unit vector v, length and width of a bay."""
    corners = list(poly.minimum_rotated_rectangle.exterior.coords)[:4]
    e1 = (corners[1][0] - corners[0][0], corners[1][1] - corners[0][1])
    e2 = (corners[2][0] - corners[1][0], corners[2][1] - corners[1][1])
    l1, l2 = math.hypot(*e1), math.hypot(*e2)
    if l1 < l2:
        e1, e2, l1, l2 = e2, e1, l2, l1
    if l2 == 0:
        return None
    return (e1[0] / l1, e1[1] / l1), (e2[0] / l2, e2[1] / l2), l1, l2


class StoreGeometry:
    def __init__(self, store_dir: Path):
        rack, aisle, dept = load(store_dir, "rack"), load(store_dir, "aisle"), load(store_dir, "department")
        rack_parts = [(fi, pi, rings) for fi, pi, rings in polygon_parts(rack)]
        all_points = [p for _, _, rings in rack_parts for p in rings[0]]
        self.proj = LocalProjection(sum(p[0] for p in all_points) / len(all_points), sum(p[1] for p in all_points) / len(all_points))
        self.racks = []
        for fi, pi, rings in rack_parts:
            poly = self.proj.polygon(rings)
            if poly.is_valid and poly.area > 0:
                self.racks.append({"feature": fi, "part": pi, "rings": rings, "poly": poly})
        self.rack_tree = STRtree([r["poly"] for r in self.racks])

        self.department_labels = [
            (f["properties"]["name"].strip().upper(), Point(self.proj.xy(*f["geometry"]["coordinates"][:2])))
            for f in dept if (f.get("geometry") or {}).get("type") == "Point"
            and not (f.get("properties") or {}).get("icon_id") and (f.get("properties") or {}).get("name")]
        self.departments = []
        for _, _, rings in polygon_parts(dept):
            poly = self.proj.polygon(rings).buffer(0)
            labels = [(name, point) for name, point in self.department_labels if poly.contains(point)]
            self.departments.append((poly, labels))
        self.department_tree = STRtree([poly for poly, _ in self.departments])

        self.aisle_labels = [(f["properties"]["name"].strip(), Point(self.proj.xy(*f["geometry"]["coordinates"][:2])))
                             for f in aisle if (f.get("geometry") or {}).get("type") == "Point"
                             and AISLE_LABEL.match(str((f.get("properties") or {}).get("name") or "").strip())]

    def blocked(self, x: float, y: float, ignore: Polygon | None = None) -> bool:
        point = Point(x, y)
        return any(self.racks[i]["poly"] is not ignore for i in self.rack_tree.query(point, predicate="intersects"))

    def department(self, rack) -> str | None:
        """Department of the most specific labelled area containing the bay, if unambiguous."""
        point = rack["poly"].representative_point()
        containing = sorted((self.departments[i] for i in self.department_tree.query(point, predicate="within")),
                            key=lambda part: part[0].area)
        for _, labels in containing:
            names = {name for name, _ in labels}
            if len(names) == 1:
                return names.pop()
            if len(names) > 1:
                nearest = {}
                for name, label in labels:
                    nearest[name] = min(nearest.get(name, math.inf), label.distance(point))
                first, second = sorted(nearest.values())[:2]
                return min(nearest, key=nearest.get) if first < 0.6 * second else None
        return None

    def aisle(self, rack) -> str | None:
        """Aisle number of the walkway the bay faces, if exactly one label qualifies."""
        axes = rect_axes(rack["poly"])
        if not axes:
            return None
        u, v, length, width = axes
        if length < 1.3 * width:  # square-ish bays have no clear facing side
            return None
        cx, cy = rack["poly"].centroid.x, rack["poly"].centroid.y
        candidates = set()
        for sign in (1, -1):
            n = (v[0] * sign, v[1] * sign)
            face = width / 2
            if self.blocked(cx + n[0] * (face + 0.4), cy + n[1] * (face + 0.4), rack["poly"]):
                continue  # back-to-back with another bay: not a customer face
            walkway = next((d / 10 for d in range(2, 61) if self.blocked(cx + n[0] * (face + d / 10), cy + n[1] * (face + d / 10))), 6.0)
            for name, label in self.aisle_labels:
                rx, ry = label.x - cx, label.y - cy
                across = rx * n[0] + ry * n[1] - face
                along = rx * u[0] + ry * u[1]
                if not (0.2 < across < walkway - 0.2) or abs(along) < length / 2 or abs(along) > 45:
                    continue
                # Walk the walkway line from the bay's end to the label; any bay in the way
                # means the label belongs to a different stretch of floor.
                step = 0.4 if along > 0 else -0.4
                ox, oy = cx + n[0] * (face + across), cy + n[1] * (face + across)
                t = length / 2 * (1 if along > 0 else -1)
                clear = True
                while abs(t) < abs(along):
                    if self.blocked(ox + u[0] * t, oy + u[1] * t):
                        clear = False
                        break
                    t += step
                if clear:
                    candidates.add(name)
        return candidates.pop() if len(candidates) == 1 else None


def nearest_aisle(geometry: "StoreGeometry", rack) -> str | None:
    """Nearest numbered aisle label within reach that no other bay hides from this one."""
    poly = rack["poly"]
    for distance, name, label in sorted(((poly.distance(label), name, label) for name, label in geometry.aisle_labels), key=lambda c: c[:2]):
        if distance > NEAREST_AISLE_RADIUS:
            return None
        edge = nearest_points(poly, label)[0]
        sight = LineString([(edge.x, edge.y), (label.x, label.y)])
        if not any(geometry.racks[i]["poly"] is not poly and geometry.racks[i]["poly"].intersection(sight).length > 0.05
                   for i in geometry.rack_tree.query(sight, predicate="intersects")):
            return name
    return None


def area_name(geometry: "StoreGeometry", rack, department: str) -> str:
    """Nearest named area label (e.g. "Back Wall"), else the bay's department."""
    poly = rack["poly"]
    distance, name = min(((poly.distance(label), name) for name, label in geometry.department_labels), default=(math.inf, ""))
    if distance <= AREA_LABEL_RADIUS:
        return name.title()
    return department.title() if department != UNASSIGNED else "Store floor"


def aisle_sort_key(aisle: str | None):
    if aisle is None:
        return (2, 0, "")
    digits = re.sub(r"\D", "", aisle)
    return (0 if aisle.isdigit() else 1, int(digits or 0), aisle)


def inventory_record(index: int, rack: dict, rng: random.Random, fill_level: float, store_id: str, now: datetime) -> dict:
    category = rack["category"]
    capacity = rng.choice([24, 32, 36, 40, 48, 60, 72])
    # Each department has its own typical fill level; bays scatter around it.
    ratio = 0.0 if rng.random() < 0.06 else min(0.99, max(0.03, rng.gauss(fill_level, 0.22)))
    occupied = 0 if ratio == 0 else max(1, min(capacity, round(capacity * ratio)))
    picks = rng.sample(PRODUCTS[category], k=rng.choice([2, 3]))
    products = []
    remaining = occupied
    for n, (name, per_slot) in enumerate(picks):
        slots = remaining if n == len(picks) - 1 else rng.randint(0, remaining)
        remaining -= slots
        quantity = max(0, slots * per_slot - rng.randint(0, per_slot - 1)) if slots else 0
        products.append({
            "product_name": name,
            "sku": f"{CATEGORY_CODES[category]}-{store_id}-{index:04d}{n + 1}",
            "stock_quantity": quantity,
            "units_per_slot": per_slot,
            "reorder_point": max(2, per_slot * 2),
        })
    stock = sum(p["stock_quantity"] for p in products)
    updated = now - timedelta(hours=rng.randint(1, 240), minutes=rng.randint(0, 59))
    centroid = ring_centroid(rack["rings"])
    return {
        "rack_id": f"R-{index:04d}",
        "aisle_id": rack["aisle_id"],
        "aisle_source": rack["aisle_source"],
        "location": rack["location"],
        "department": rack["department"].title() if rack["department"] != UNASSIGNED else UNASSIGNED,
        "product_category": category,
        "product_name": products[0]["product_name"],
        "sku": products[0]["sku"],
        "products": products,
        "storage_capacity": capacity,
        "occupied_capacity": occupied,
        "available_capacity": capacity - occupied,
        "occupancy_percentage": round(occupied / capacity * 100, 1),
        "stock_quantity": stock,
        "last_updated": updated.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "inventory_status": "Out of Stock" if stock == 0 else "Low Stock" if stock <= sum(p["reorder_point"] for p in products) else "In Stock",
        "geometry_ref": {"layer": "Lowes_rack", "feature": rack["feature"], "part": rack["part"],
                         "source_centroid": [round(centroid[0], 9), round(centroid[1], 9)]},
    }


def generate(store_dir: Path) -> dict | None:
    store_id = store_dir.name
    if not (store_dir / "rack.geojson").is_file():
        return None
    geometry = StoreGeometry(store_dir)
    rng = random.Random(f"lowes-inventory-{store_id}")
    racks = []
    for rack in geometry.racks:
        if rack["poly"].area < MIN_RACK_AREA:
            continue
        department = geometry.department(rack) or UNASSIGNED
        categories = DEPARTMENT_CATEGORIES.get(department, (DEFAULT_CATEGORY,))
        racks.append({**rack, "department": department, "aisle": geometry.aisle(rack), "category": rng.choice(categories)})
    racks.sort(key=lambda r: (r["department"] == UNASSIGNED, r["department"], aisle_sort_key(r["aisle"]),
                              -round(r["poly"].centroid.y, 1), round(r["poly"].centroid.x, 1)))
    # Fallbacks are filled in after sorting so rack IDs (sorted by the walkway
    # aisle) and the random stock levels stay as they were.
    for rack in racks:
        nearest = None if rack["aisle"] else nearest_aisle(geometry, rack)
        rack["aisle_id"] = rack["aisle"] or nearest
        rack["aisle_source"] = "walkway" if rack["aisle"] else "nearest" if nearest else None
        rack["location"] = None if rack["aisle_id"] else area_name(geometry, rack, rack["department"])
    fill_levels = {department: rng.uniform(0.3, 0.85) for department in sorted({r["department"] for r in racks})}
    now = datetime(2026, 10, 9, 12, 0, tzinfo=timezone.utc)
    records = [inventory_record(i + 1, rack, rng, fill_levels[rack["department"]], store_id, now) for i, rack in enumerate(racks)]
    store = json.loads((store_dir / "store.json").read_text(encoding="utf-8")) if (store_dir / "store.json").is_file() else {}
    return {
        "simulated": True,
        "notice": "Simulated stock - not connected to any live inventory system.",
        "store_id": store_id,
        "store_name": store.get("name"),
        "generated_at": now.isoformat().replace("+00:00", "Z"),
        "occupancy_rules": {"high": "> 70% occupied", "partial": "30-70% occupied", "low": "< 30% occupied", "vacant": "0% occupied"},
        "racks": records,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--stores", help="Comma-separated store IDs (default: all with rack data)")
    args = parser.parse_args()
    wanted = set(args.stores.split(",")) if args.stores else None
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for store_dir in sorted(p for p in STORES_DIR.iterdir() if p.is_dir()):
        if wanted and store_dir.name not in wanted:
            continue
        result = generate(store_dir)
        if not result:
            continue
        path = OUTPUT_DIR / f"{store_dir.name}.json"
        path.write_text(json.dumps(result, separators=(",", ":")) + "\n", encoding="utf-8")
        racks = result["racks"]
        unassigned = sum(r["department"] == UNASSIGNED for r in racks)
        no_aisle = sum(r["aisle_id"] is None for r in racks)
        nearest = sum(r["aisle_source"] == "nearest" for r in racks)
        print(f"{store_dir.name}: {len(racks)} racks ({unassigned} unassigned department, {nearest} aisle from nearest label, {no_aisle} by area name) "
              f"-> {path.relative_to(ROOT)} ({path.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
