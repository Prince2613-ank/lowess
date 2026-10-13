"""Back-of-house fulfilment areas built by scripts/build_store_zones.py and the
Pack & Dispatch point the walking network routes carts from."""
import base64
import json
import sys
from collections import deque
from pathlib import Path

import numpy as np
from shapely.geometry import Point, Polygon
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from generate_inventory import StoreGeometry, load  # noqa: E402

DATA = ROOT / "frontend" / "data"


def reachable(network: dict, start: int) -> set[int]:
    grid = network["grid"]
    cols, rows = grid["cols"], grid["rows"]
    walkable = np.unpackbits(np.frombuffer(base64.b64decode(grid["mask"]), dtype=np.uint8), bitorder="little")[: cols * rows]
    seen, queue = {start}, deque([start])
    while queue:
        r, c = divmod(queue.popleft(), cols)
        for nr, nc in ((r + 1, c), (r - 1, c), (r, c + 1), (r, c - 1)):
            cell = nr * cols + nc
            if 0 <= nr < rows and 0 <= nc < cols and walkable[cell] and cell not in seen:
                seen.add(cell)
                queue.append(cell)
    return seen


def test_every_store_has_back_of_house_areas_and_routes_from_pack_and_dispatch():
    stores = sorted(p for p in (ROOT / "stores").iterdir() if (p / "rack.geojson").is_file())
    assert stores
    for store_dir in stores:
        sid = store_dir.name
        zones = {z["type"]: z for z in json.loads((DATA / "zones" / f"{sid}.json").read_text(encoding="utf-8"))["zones"]}
        assert set(zones) == {"receiving", "dispatch", "returns"}, sid

        geometry = StoreGeometry(store_dir)
        proj = geometry.proj
        sales_floor = unary_union([poly for poly, _ in geometry.departments])
        desk = next((Point(proj.xy(*f["geometry"]["coordinates"][:2])) for f in load(store_dir, "department")
                     if (f.get("properties") or {}).get("icon_id") == "receiving_desk"), None)
        rack_ids = {r["rack_id"] for r in json.loads((DATA / "inventory" / f"{sid}.json").read_text(encoding="utf-8"))["racks"]}
        areas = {kind: Polygon([proj.xy(lon, lat) for lon, lat in z["polygon"]]) for kind, z in zones.items()}

        for kind, area in areas.items():
            assert area.is_valid and area.area > 20, (sid, kind)
            # Staff-only back of house: off the sales floor.
            assert area.intersection(sales_floor).area < 0.02 * area.area, (sid, kind)
            assert set(zones[kind]["rack_ids"]) <= rack_ids, (sid, kind)
            assert zones[kind]["source"] == ("map_marker" if desk is not None else "inferred"), (sid, kind)
        # One back-of-house block: sections do not overlap and Pack & Dispatch adjoins Receiving.
        assert areas["receiving"].intersection(areas["dispatch"]).area < 1.0, sid
        assert areas["dispatch"].intersection(areas["returns"]).area < 1.0, sid
        assert areas["receiving"].distance(areas["dispatch"]) < 1.0, sid
        if desk is not None:
            assert areas["receiving"].distance(desk) <= 3.0, sid  # built at the map's receiving desk
        assert zones["receiving"]["rack_ids"], sid

        # Carts start and finish at Pack & Dispatch, on the main store floor.
        network = json.loads((DATA / "routing" / f"{sid}.json").read_text(encoding="utf-8"))
        dispatch = network["dispatch"]
        assert dispatch["zone_id"] == zones["dispatch"]["id"] and dispatch["cell"] is not None, sid
        cols, cell = network["grid"]["cols"], dispatch["cell"]
        point = Point(network["grid"]["x0"] + (cell % cols + 0.5) * network["grid"]["cell"],
                      network["grid"]["y0"] + (cell // cols + 0.5) * network["grid"]["cell"])
        assert areas["dispatch"].distance(point) <= 8.0, sid
        connected = reachable(network, cell)
        access = network["rack_access"]
        assert sum(1 for c in access.values() if c in connected) >= 0.9 * len(rack_ids), sid
        orders = json.loads((DATA / "orders" / f"{sid}.json").read_text(encoding="utf-8"))["orders"]
        assert all(access[line["rack_id"]] in connected for order in orders for line in order["lines"]), sid
