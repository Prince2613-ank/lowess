"""Back-of-house fulfilment areas built by scripts/build_store_zones.py and the
Pack & Dispatch point the walking network routes carts from."""
import base64
import json
import sys
from collections import deque
from pathlib import Path

import numpy as np
from shapely import STRtree
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from build_store_zones import outer_wall, store_layout  # noqa: E402
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
    walls_total = [0, 0]  # doors on the outer wall, all doors
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

        # Receiving and Pack & Dispatch have an outside door on the building's outer wall, at the
        # back; Returns has none (drivers use the driver door next to it).
        assert zones["returns"]["door"] is None, sid
        building = outer_wall(store_layout(store_dir), list(areas.values()))
        customer = [Point(proj.xy(*f["geometry"]["coordinates"][:2])) for f in load(store_dir, "department")
                    if (f.get("properties") or {}).get("icon_id") == "entrance_exit"]
        doors, on_wall = {}, []
        for kind in ("receiving", "dispatch"):
            door = zones[kind]["door"]
            assert door and door["width_m"] > 0, (sid, kind)
            centre = Point(proj.xy(*door["position"]))
            opening = LineString([proj.xy(*p) for p in door["opening"]])
            assert abs(opening.length - door["width_m"]) < 0.05, (sid, kind)
            assert areas[kind].exterior.distance(centre) < 0.5, (sid, kind)       # on the area's own edge
            outside = Point(proj.xy(*door["outside"]))
            assert not any(area.contains(outside) for area in areas.values()), (sid, kind)  # opens out of the areas
            assert not sales_floor.contains(outside), (sid, kind)                 # never onto the sales floor
            if building.exterior.distance(centre) < 0.5:                          # on the outer wall: opens outside
                assert not building.contains(outside), (sid, kind)
                on_wall.append(kind)
            assert min(c.distance(centre) for c in customer) > 40, (sid, kind)    # not the customer front
            doors[kind] = centre
        assert min(a.distance(b) for a in doors.values() for b in doors.values() if a is not b) > 4, sid
        walls_total[0] += len(on_wall)
        walls_total[1] += len(doors)

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

        # Every picking point faces its rack: a clear straight line to the shelf, never through another rack.
        by_id = {r["rack_id"]: r for r in json.loads((DATA / "inventory" / f"{sid}.json").read_text(encoding="utf-8"))["racks"]}
        polys = {(r["feature"], r["part"]): r["poly"] for r in geometry.racks}
        tree = STRtree([r["poly"] for r in geometry.racks])
        all_racks = [r["poly"] for r in geometry.racks]
        grid = network["grid"]
        for rack_id in {line["rack_id"] for order in orders for line in order["lines"]}:
            ref = by_id[rack_id]["geometry_ref"]
            rack = polys[(ref["feature"], ref["part"])]
            c = access[rack_id]
            spot = Point(grid["x0"] + (c % grid["cols"] + 0.5) * grid["cell"], grid["y0"] + (c // grid["cols"] + 0.5) * grid["cell"])
            sight = LineString([spot, rack.boundary.interpolate(rack.boundary.project(spot))])
            assert rack.distance(spot) <= 2.0, (sid, rack_id)
            assert not any(all_racks[i] is not rack and all_racks[i].intersection(sight).length > 0.05
                           for i in tree.query(sight, predicate="intersects")), (sid, rack_id)
    # Almost every door is on the building's outer wall; the rest face away from the floor and areas.
    assert walls_total[0] >= 0.9 * walls_total[1], walls_total
