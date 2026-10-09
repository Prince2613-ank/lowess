"""Build the indoor walking network used for order-picking routes.

For every store with map + inventory data this writes
``frontend/data/routing/<store_id>.json``: a walkable occupancy grid in the
store's own source coordinates (the browser applies the same alignment as the
map), plus the picking access cell of every inventory rack and of the
PRODUCT PICK-UP desk. Map GeoJSON is never modified.

Walkable floor is derived only from mapped geometry:

* floor   = mapped department areas, plus the customer service front-end
            (6 m around checkout / pick-up / service-desk markers), with gaps
            narrower than 10 m between them closed - these are the corridors
            and cross-aisles bounded on both sides by mapped floor;
* blocked = every rack bay and fixture (Lowes_rack and Lowes_aisle polygons)
            grown by a 0.35 m cart clearance;
* walkable = floor - blocked, sampled on a 0.5 m grid.

Racks with no walkable cell within 2 m are reported, not given an invented
access point. Entrances are not used as floor because they sit on the building
edge.

Usage:  python scripts/build_routing_network.py [--stores 1665,2544]
"""
from __future__ import annotations

import argparse
import base64
import json
from collections import deque
from pathlib import Path

import numpy as np
import shapely
from shapely.geometry import Point
from shapely.ops import unary_union

from generate_inventory import OUTPUT_DIR as INVENTORY_DIR, ROOT, STORES_DIR, StoreGeometry, load, polygon_parts

OUTPUT_DIR = ROOT / "frontend" / "data" / "routing"
CELL = 0.5            # m
CLEARANCE = 0.35      # m, half a picking cart
CLOSE_RADIUS = 5.0    # m, closes gaps up to 10 m between mapped floor areas
SERVICE_RADIUS = 6.0  # m around front-end service markers
RACK_ACCESS_RADIUS = 2.0
POI_ACCESS_RADIUS = 8.0
SERVICE_ICONS = {"checkouts", "store_pick_up", "pickup_lockers", "customer_service_desk", "pro_service_desk", "returns"}
PICKUP_ICON = "store_pick_up"


def components(mask: np.ndarray) -> np.ndarray:
    """4-connected component label per walkable cell (-1 for blocked), largest first."""
    rows, cols = mask.shape
    labels = np.full(mask.shape, -1, dtype=np.int32)
    sizes = []
    for start in zip(*np.nonzero(mask)):
        if labels[start] != -1:
            continue
        label, size = len(sizes), 0
        labels[start] = label
        queue = deque([start])
        while queue:
            r, c = queue.popleft()
            size += 1
            for nr, nc in ((r + 1, c), (r - 1, c), (r, c + 1), (r, c - 1)):
                if 0 <= nr < rows and 0 <= nc < cols and mask[nr, nc] and labels[nr, nc] == -1:
                    labels[nr, nc] = label
                    queue.append((nr, nc))
        sizes.append(size)
    order = np.argsort(sizes)[::-1]
    remap = np.empty(len(sizes), dtype=np.int32)
    remap[order] = np.arange(len(sizes))
    out = labels.copy()
    out[labels >= 0] = remap[labels[labels >= 0]]
    return out


class Grid:
    def __init__(self, walkable_area, bounds):
        minx, miny, maxx, maxy = bounds
        self.x0, self.y0 = minx, miny
        self.cols = int(np.ceil((maxx - minx) / CELL)) + 1
        self.rows = int(np.ceil((maxy - miny) / CELL)) + 1
        xs = self.x0 + (np.arange(self.cols) + 0.5) * CELL
        ys = self.y0 + (np.arange(self.rows) + 0.5) * CELL
        self.cx, self.cy = np.meshgrid(xs, ys)
        shapely.prepare(walkable_area)
        self.mask = shapely.contains_xy(walkable_area, self.cx, self.cy)
        self.labels = components(self.mask)

    def nearest(self, geometry, radius: float) -> int | None:
        """Index (row * cols + col) of the walkable cell nearest to the geometry, within radius."""
        minx, miny, maxx, maxy = geometry.bounds
        c0, c1 = max(0, int((minx - radius - self.x0) / CELL)), min(self.cols - 1, int((maxx + radius - self.x0) / CELL) + 1)
        r0, r1 = max(0, int((miny - radius - self.y0) / CELL)), min(self.rows - 1, int((maxy + radius - self.y0) / CELL) + 1)
        window = self.mask[r0:r1 + 1, c0:c1 + 1]
        if not window.any():
            return None
        rr, cc = np.nonzero(window)
        rr, cc = rr + r0, cc + c0
        distances = shapely.distance(geometry, shapely.points(self.cx[rr, cc], self.cy[rr, cc]))
        best = int(np.argmin(distances))
        return int(rr[best] * self.cols + cc[best]) if distances[best] <= radius else None

    def packed_mask(self) -> str:
        return base64.b64encode(np.packbits(self.mask.ravel(), bitorder="little").tobytes()).decode("ascii")


def build(store_dir: Path) -> dict | None:
    store_id = store_dir.name
    inventory_path = INVENTORY_DIR / f"{store_id}.json"
    if not (store_dir / "rack.geojson").is_file() or not inventory_path.is_file():
        return None
    geometry = StoreGeometry(store_dir)
    proj = geometry.proj
    departments = load(store_dir, "department")
    fixtures = [proj.polygon(rings).buffer(0) for _, _, rings in polygon_parts(load(store_dir, "aisle"))]
    racks = [rack["poly"] for rack in geometry.racks]
    pois = [f for f in departments if (f.get("geometry") or {}).get("type") == "Point" and (f.get("properties") or {}).get("icon_id")]
    service = [Point(proj.xy(*f["geometry"]["coordinates"][:2])).buffer(SERVICE_RADIUS)
               for f in pois if f["properties"]["icon_id"] in SERVICE_ICONS]

    mapped_floor = unary_union([poly for poly, _ in geometry.departments] + service)
    floor = mapped_floor.buffer(CLOSE_RADIUS, join_style="mitre").buffer(-CLOSE_RADIUS, join_style="mitre")
    blocked = unary_union(racks + fixtures).buffer(CLEARANCE)
    walkable = floor.difference(blocked)
    grid = Grid(walkable, floor.bounds)

    pickup = None
    for f in pois:
        if f["properties"]["icon_id"] == PICKUP_ICON:
            lon, lat = f["geometry"]["coordinates"][:2]
            cell = grid.nearest(Point(proj.xy(lon, lat)), POI_ACCESS_RADIUS)
            pickup = {"name": f["properties"].get("poi_name") or "Product Pick-Up", "icon_id": PICKUP_ICON,
                      "source": [lon, lat], "cell": cell}
            break

    part_to_rack = {(r["geometry_ref"]["feature"], r["geometry_ref"]["part"]): r["rack_id"]
                    for r in json.loads(inventory_path.read_text(encoding="utf-8"))["racks"]}
    rack_access, no_access = {}, []
    for rack in geometry.racks:
        rack_id = part_to_rack.get((rack["feature"], rack["part"]))
        if not rack_id:
            continue
        cell = grid.nearest(rack["poly"], RACK_ACCESS_RADIUS)
        if cell is None:
            no_access.append(rack_id)
        else:
            rack_access[rack_id] = cell

    labels = grid.labels.ravel()
    main = 0
    if pickup and pickup["cell"] is not None:
        main = int(labels[pickup["cell"]])
    reachable = sum(1 for cell in rack_access.values() if labels[cell] == main)
    sizes = np.bincount(labels[labels >= 0]) if grid.mask.any() else np.array([0])
    return {
        "version": 1,
        "store_id": store_id,
        "description": "Walkable grid derived from mapped department floor, front-end service areas and corridors between them, minus racks and fixtures with cart clearance.",
        "projection": {"lon0": proj.lon0, "lat0": proj.lat0, "kx": proj.kx, "ky": proj.ky},
        "grid": {"x0": grid.x0, "y0": grid.y0, "cell": CELL, "cols": grid.cols, "rows": grid.rows,
                 "mask": grid.packed_mask(), "clearance": CLEARANCE},
        "pickup": pickup,
        "rack_access": rack_access,
        "stats": {
            "walkable_cells": int(grid.mask.sum()),
            "components": int(len(sizes)),
            "main_component_share": round(float(sizes.max() / sizes.sum()), 4) if sizes.sum() else 0,
            "racks_with_access": len(rack_access),
            "racks_without_access": len(no_access),
            "racks_reachable_from_pickup": reachable,
        },
        "racks_without_access": no_access,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--stores", help="Comma-separated store IDs (default: all with map + inventory data)")
    args = parser.parse_args()
    wanted = set(args.stores.split(",")) if args.stores else None
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for store_dir in sorted(p for p in STORES_DIR.iterdir() if p.is_dir()):
        if wanted and store_dir.name not in wanted:
            continue
        network = build(store_dir)
        if not network:
            continue
        path = OUTPUT_DIR / f"{store_dir.name}.json"
        path.write_text(json.dumps(network, separators=(",", ":")) + "\n", encoding="utf-8")
        stats = network["stats"]
        pickup = network["pickup"]
        print(f"{store_dir.name}: {network['grid']['cols']}x{network['grid']['rows']} grid, {stats['components']} components "
              f"(main {stats['main_component_share']:.0%}), pick-up {'ok' if pickup and pickup['cell'] is not None else 'MISSING'}, "
              f"racks reachable {stats['racks_reachable_from_pickup']}/{stats['racks_with_access'] + stats['racks_without_access']} "
              f"-> {path.relative_to(ROOT)} ({path.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
