"""Lay out the back-of-house areas of every store for online-order fulfilment.

Online orders are picked by store staff, packed, and handed to a delivery
driver; drivers also bring returned items back. All of it happens behind the
sales floor, so three staff-only areas are placed together in back-of-house:
Receiving (supplier stock in), Pack & Dispatch (orders out to drivers) and
Returns (items back from drivers). The customer-facing front end is not used.

The maps mark no dock doors and no area outlines. The one back-of-house
marker is the RECEIVING DESK (``icon_id: receiving_desk``, 15 of 16 stores),
always at the back of the building, facing the truck yard - used as the
stand-in for the dock:

* Back-of-house block - every receiving desk sits in a group of back-room racks
  (racks outside the sales-floor departments, chained at gaps up to 4 m). The
  maps draw no back-room walls, so the room's edge is taken from what stands
  along it: the block is the outline of that group, the desk and every other
  back-room rack, fixture and drawn shape within 10 m of it, kept off the
  sales floor (and out of gaps under 6 m between its departments).
* The block is divided along its length into three sections by floor area,
  each keeping its racks as that area's shelving (``rack_ids``):
    Receiving        ~50 %, centred on the receiving desk (dock side);
    Pack & Dispatch  ~30 %, next to Receiving - pick carts start and finish
                     here, packed orders are staged and handed to drivers;
    Returns          ~20 %, next to Pack & Dispatch (or on the far side of
                     Receiving when the desk is mid-block) - items brought
                     back by drivers wait here for inspection.

When a store has no receiving desk (Bloomfield #1665), its position is inferred
from the store with the most similar footprint, scaled into this building, and
the nearest back-room rack group is used. Every zone records how it was found
(``source``).

Doors - the maps' only door markers (``entrance_exit``) are the customer
entrances at the front, 55-130 m from back-of-house. So Receiving and Pack &
Dispatch each get an inferred outside door (``door``) on their stretch of the
building's outer wall (the outline of everything mapped, gaps under 6 m
closed), on a straight piece of wall long enough for it:
    Receiving        dock door, 3.0 m, on the wall nearest the receiving desk;
    Pack & Dispatch  driver hand-off door, 2.4 m, mid-way along its longest wall.
Returns has no door of its own: drivers bring returned items in through the
driver hand-off door next door (``door: null``).

Writes ``frontend/data/zones/<store_id>.json`` in source coordinates (the
browser aligns them like the map). Map GeoJSON is never modified.

Usage:  python scripts/build_store_zones.py [--stores 1665,2544]
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
import shapely

from shapely import affinity
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import unary_union

from build_routing_network import outlines
from generate_inventory import OUTPUT_DIR as INVENTORY_DIR, ROOT, STORES_DIR, StoreGeometry, load, polygon_parts

OUTPUT_DIR = ROOT / "frontend" / "data" / "zones"
DESK_ICON = "receiving_desk"
RACK_GAP = 4.0          # m: back-room racks this close belong to one group
ROOM_REACH = 10.0       # m: other back-room racks, fixtures and shapes this close mark the room's edge
MIN_GROUP = 15          # racks: smallest back-room group used for an inferred position
SHARES = {"receiving": 0.5, "dispatch": 0.3, "returns": 0.2}
NAMES = {"receiving": "Receiving Area", "dispatch": "Pack & Dispatch", "returns": "Returns Area"}
PREFIX = {"receiving": "RCV", "dispatch": "DSP", "returns": "RTN"}
DOORS = {  # name, opening width (m)
    "receiving": ("Dock door", 3.0),
    "dispatch": ("Driver hand-off door", 2.4),
}
WALL_TOLERANCE = 1.5    # m: area edge this close to the outer wall is outer wall
WALL_TURN = 10.0        # degrees: wall pieces turning less than this are one straight wall
DOOR_MARGIN = 0.5       # m kept clear between a door and the end of its wall


def store_layout(store_dir: Path) -> dict:
    geometry = StoreGeometry(store_dir)
    points = {f["properties"]["icon_id"]: Point(geometry.proj.xy(*f["geometry"]["coordinates"][:2]))
              for f in load(store_dir, "department") if (f.get("properties") or {}).get("icon_id")}
    sales_floor = unary_union([poly for poly, _ in geometry.departments])
    off_floor = lambda poly: poly.area > 0 and poly.intersection(sales_floor).area < 0.2 * poly.area
    back_room = [r for r in geometry.racks if off_floor(r["poly"])]
    fixtures = [geometry.proj.polygon(rings).buffer(0) for _, _, rings in polygon_parts(load(store_dir, "aisle"))]
    shapes = [poly for poly in fixtures + outlines(store_dir, geometry.proj)[1] if off_floor(poly)]
    return {"geometry": geometry, "proj": geometry.proj, "points": points, "sales_floor": sales_floor,
            "back_room": back_room, "back_room_shapes": shapes, "bounds": sales_floor.bounds, "store_dir": store_dir}


def outer_wall(layout: dict, areas: list) -> Polygon:
    """The building's outline: everything mapped (floor areas, racks, fixtures,
    drawn outlines and the back-of-house areas), gaps under 6 m closed, holes filled."""
    store_dir, proj = layout["store_dir"], layout["proj"]
    fixtures = [proj.polygon(rings).buffer(0) for _, _, rings in polygon_parts(load(store_dir, "aisle"))]
    parts = ([poly for poly, _ in layout["geometry"].departments] + [r["poly"] for r in layout["geometry"].racks]
             + fixtures + outlines(store_dir, proj)[1] + areas)
    shape = unary_union(parts).buffer(3.0, join_style="mitre").buffer(-3.0, join_style="mitre")
    return Polygon(max(getattr(shape, "geoms", [shape]), key=lambda piece: piece.area).exterior)


def straight_walls(area, building: Polygon) -> list[LineString]:
    """Straight pieces of the area's edge that lie on the building's outer wall."""
    edge = area.exterior.intersection(building.exterior.buffer(WALL_TOLERANCE))
    walls = []
    for piece in getattr(edge, "geoms", [edge]):
        if not isinstance(piece, LineString) or piece.length < 1.0:
            continue
        run = [piece.coords[0]]
        for a, b in zip(piece.coords, piece.coords[1:]):
            if len(run) >= 2:
                h0 = math.atan2(run[-1][1] - run[-2][1], run[-1][0] - run[-2][0])
                h1 = math.atan2(b[1] - a[1], b[0] - a[0])
                if abs((math.degrees(h1 - h0) + 180) % 360 - 180) > WALL_TURN:
                    walls.append(LineString([run[0], run[-1]]))
                    run = [a]
            run.append(b)
        if len(run) >= 2:
            walls.append(LineString([run[0], run[-1]]))
    return [wall for wall in walls if wall.length > 0.1]


def place_door(kind: str, area, building: Polygon, desk: Point | None, sales_floor, others: list) -> dict | None:
    """An outside door for the area on a straight piece of its outer wall - or,
    when none of its sides lies on the outer wall, on the side nearest it that
    faces neither the sales floor nor another area."""
    name, width = DOORS[kind]
    walls = [wall for wall in straight_walls(area, building) if wall.length >= width + 2 * DOOR_MARGIN]
    outward = None
    if not walls:
        coords = list(area.exterior.coords)
        sides = [LineString([a, b]) for a, b in zip(coords, coords[1:])]
        near_floor = sales_floor.buffer(1.0)
        sides = [s for s in sides if s.length >= width + 2 * DOOR_MARGIN
                 and s.intersection(near_floor).length < 0.3 * s.length
                 and all(s.interpolate(0.5, normalized=True).distance(o) > 0.5 for o in others)]
        if not sides:
            return None
        walls = [min(sides, key=lambda s: s.interpolate(0.5, normalized=True).distance(building.exterior))]
        outward = area.centroid
    if kind == "receiving" and desk is not None:
        wall = min(walls, key=lambda w: (round(w.distance(desk), 0), -w.length))
        at = wall.project(desk)  # straight out from the desk
    else:
        wall = max(walls, key=lambda w: w.length)
        at = wall.length / 2
    at = min(max(at, width / 2 + DOOR_MARGIN), wall.length - width / 2 - DOOR_MARGIN)
    a, b = wall.interpolate(at - width / 2), wall.interpolate(at + width / 2)
    centre = wall.interpolate(at)
    dx, dy = (b.x - a.x) / width, (b.y - a.y) / width
    if outward is not None:  # away from the area's middle
        normal = (-dy, dx) if Point(centre.x - dy, centre.y + dx).distance(outward) > centre.distance(outward) else (dy, -dx)
    else:
        normal = (-dy, dx) if not building.contains(Point(centre.x - dy, centre.y + dx)) else (dy, -dx)
    return {"name": name, "width_m": width, "centre": centre, "opening": (a, b), "outward": normal,
            "wall_m": wall.length}


def rack_groups(racks: list[dict]) -> list[list[dict]]:
    """Back-room racks chained into groups at gaps up to RACK_GAP, largest first."""
    remaining, groups = list(racks), []
    while remaining:
        group, frontier = [], [remaining.pop()]
        while frontier:
            rack = frontier.pop()
            group.append(rack)
            near = [r for r in remaining if r["poly"].distance(rack["poly"]) <= RACK_GAP]
            for r in near:
                remaining.remove(r)
            frontier.extend(near)
        groups.append(group)
    return sorted(groups, key=len, reverse=True)


def back_of_house(layout: dict, desk: Point, marker: bool):
    """Outline of the back-room rack group at the desk (or nearest an inferred position)."""
    distance = lambda group: min(r["poly"].distance(desk) for r in group)
    groups = rack_groups(layout["back_room"])
    if marker:
        group = min(groups, key=distance, default=None)
        if group is None or distance(group) > RACK_GAP:
            return None, []
    else:
        group = min((g for g in groups if len(g) >= MIN_GROUP), key=distance, default=None)
        if group is None:
            return None, []
    parts = [r["poly"] for r in group] + ([desk.buffer(1.5)] if marker else [])
    # Stretch to the room's edge: back-room racks, fixtures and shapes standing near the group.
    reach = unary_union(parts).convex_hull.buffer(ROOM_REACH)
    near = lambda poly: reach.contains(poly.representative_point())
    members = {id(r) for r in group}
    extra_racks = [r for r in layout["back_room"] if id(r) not in members and near(r["poly"])]
    extra = [r["poly"] for r in extra_racks] + [poly for poly in layout["back_room_shapes"] if near(poly)]
    # Kept off the sales floor and out of the gaps between its departments (under 6 m).
    floor = layout["sales_floor"].buffer(3.0, join_style="mitre").buffer(-3.0, join_style="mitre")
    outline = unary_union(parts + extra).convex_hull.buffer(1.0, join_style="mitre").difference(floor)
    pieces = sorted(getattr(outline, "geoms", [outline]), key=lambda piece: (round(piece.distance(desk), 1), -piece.area))
    return pieces[0].simplify(0.2), group + extra_racks


def building_angle(sales_floor) -> float:
    """Direction of the building's walls (degrees): the long side of the
    smallest rectangle around the sales floor."""
    corners = list(sales_floor.minimum_rotated_rectangle.exterior.coords)
    (x0, y0), (x1, y1), (x2, y2) = corners[:3]
    if (x1 - x0) ** 2 + (y1 - y0) ** 2 < (x2 - x1) ** 2 + (y2 - y1) ** 2:
        (x0, y0), (x1, y1) = (x1, y1), (x2, y2)
    return math.degrees(math.atan2(y1 - y0, x1 - x0))


def largest_free_rectangle(bounds, blocked, cell: float = 0.5):
    """Largest rectangle (square to the axes) inside bounds that keeps off blocked."""
    x0, y0, x1, y1 = bounds
    cols, rows = max(1, int(round((x1 - x0) / cell))), max(1, int(round((y1 - y0) / cell)))
    dx, dy = (x1 - x0) / cols, (y1 - y0) / rows
    xs, ys = np.meshgrid(x0 + (np.arange(cols) + 0.5) * dx, y0 + (np.arange(rows) + 0.5) * dy)
    free = ~shapely.contains_xy(blocked, xs, ys) if not blocked.is_empty else np.ones((rows, cols), bool)
    best, found = 0.0, None
    heights = np.zeros(cols, int)
    for r in range(rows):  # largest rectangle in a histogram, row by row
        heights = np.where(free[r], heights + 1, 0)
        stack = []
        for c in range(cols + 1):
            h = heights[c] if c < cols else 0
            start = c
            while stack and stack[-1][1] >= h:
                start, height = stack.pop()
                if height * (c - start) > best:
                    best, found = height * (c - start), (start, r - height + 1, c, r + 1)
            stack.append((start, h))
    if found is None:
        return None
    c0, r0, c1, r1 = found
    return box(x0 + c0 * dx, y0 + r0 * dy, x0 + c1 * dx, y0 + r1 * dy)


def sections(block, desk: Point, sales_floor, angle: float) -> dict:
    """Split the block along the back wall by floor area: Receiving around the
    desk, Pack & Dispatch next to it, Returns beyond (or on the other side).
    Shares are of the block's floor area, so a tapering end still gives its
    area a full share. Each area is then the largest rectangle, square to the
    building, within its stretch of the block's outline (to the furthest point
    of the block) that stays off the sales floor."""
    turn = lambda g: affinity.rotate(g, -angle, origin=(0, 0))
    unturn = lambda g: affinity.rotate(g, angle, origin=(0, 0))
    block, desk, floor = turn(block), turn(desk), turn(sales_floor)
    minx, miny, maxx, maxy = block.bounds
    along_x = (maxx - minx) >= (maxy - miny)
    lo, hi = (minx, maxx) if along_x else (miny, maxy)
    slab = lambda a, b: box(a, miny, b, maxy) if along_x else box(minx, a, maxx, b)
    share_upto = lambda x: block.intersection(slab(lo, x)).area / block.area

    def position(share: float) -> float:
        """Where along the axis the given share of floor area is reached."""
        a, b = lo, hi
        for _ in range(40):
            mid = (a + b) / 2
            a, b = (mid, b) if share_upto(mid) < share else (a, mid)
        return (a + b) / 2

    at = share_upto(min(max(desk.x if along_x else desk.y, lo), hi))
    r0 = min(max(at - SHARES["receiving"] / 2, 0.0), 1.0 - SHARES["receiving"])
    r1 = r0 + SHARES["receiving"]
    # Pack & Dispatch on the roomier side of Receiving; Returns after it if
    # there is space on that side, otherwise on the opposite side.
    if 1.0 - r1 >= r0:
        bands = {"dispatch": (r1, min(1.0, r1 + SHARES["dispatch"]))}
        bands["returns"] = (bands["dispatch"][1], 1.0) if 1.0 - bands["dispatch"][1] >= 0.1 else (0.0, r0)
    else:
        bands = {"dispatch": (max(0.0, r0 - SHARES["dispatch"]), r0)}
        bands["returns"] = (0.0, bands["dispatch"][0]) if bands["dispatch"][0] >= 0.1 else (r1, 1.0)
    bands["receiving"] = (r0, r1)
    out = {}
    for kind in ("receiving", "dispatch", "returns"):
        a, b = bands[kind]
        if b - a < 0.05:
            continue
        s0, s1 = lo if a <= 0 else position(a), hi if b >= 1 else position(b)
        part = block.intersection(slab(s0, s1))
        if part.is_empty:
            continue
        px0, py0, px1, py1 = part.bounds
        stretch = (s0, py0, s1, py1) if along_x else (px0, s0, px1, s1)
        rect = largest_free_rectangle(stretch, floor)
        if rect is None or rect.area < 0.5 * part.area:
            out[kind] = unturn(max(getattr(part, "geoms", [part]), key=lambda piece: piece.area))
            continue
        out[kind] = unturn(rect)
    return out


def relative(point: Point, bounds) -> tuple[float, float]:
    minx, miny, maxx, maxy = bounds
    return (point.x - minx) / (maxx - minx), (point.y - miny) / (maxy - miny)


def to_lonlat(proj, x: float, y: float) -> list[float]:
    return [round(proj.lon0 + x / proj.kx, 9), round(proj.lat0 + y / proj.ky, 9)]


def size(layout: dict) -> tuple[float, float]:
    minx, miny, maxx, maxy = layout["bounds"]
    return maxx - minx, maxy - miny


def build(store_dir: Path, layout: dict, templates: list) -> dict:
    proj, store_id = layout["proj"], store_dir.name
    result = {"version": 2, "store_id": store_id,
              "description": "Staff-only back-of-house areas for online-order fulfilment (Receiving, Pack & Dispatch, Returns), "
                             "laid out around the store map's receiving desk - the stand-in for the dock, as no dock doors are mapped.",
              "zones": []}
    desk = layout["points"].get(DESK_ICON)
    source, origin = "map_marker", "Laid out around the receiving desk marker on the store map."
    if desk is None:
        template = min(templates, key=lambda t: abs(t["size"][0] - size(layout)[0]) + abs(t["size"][1] - size(layout)[1]), default=None)
        if template is None:
            return result
        minx, miny, maxx, maxy = layout["bounds"]
        u, v = template["relative"]
        desk = Point(minx + u * (maxx - minx), miny + v * (maxy - miny))
        source = "inferred"
        origin = (f"No receiving desk marker in this store's map; position taken from store #{template['store_id']}, "
                  f"the most similar building ({template['size'][0]:.0f} x {template['size'][1]:.0f} m).")
    block, group = back_of_house(layout, desk, source == "map_marker")
    if block is None:
        print(f"{store_id}: no back-room rack group near the receiving position")
        return result
    if source == "inferred":
        desk = block.exterior.interpolate(block.exterior.project(desk))  # marker on the block's nearest edge
    part_to_rack = {}
    inventory_path = INVENTORY_DIR / f"{store_id}.json"
    if inventory_path.is_file():
        part_to_rack = {(r["geometry_ref"]["feature"], r["geometry_ref"]["part"]): r["rack_id"]
                        for r in json.loads(inventory_path.read_text(encoding="utf-8"))["racks"]}
    purpose = {
        "receiving": "Supplier deliveries are checked in here and put away to the racks.",
        "dispatch": "Pick carts start and finish here; orders are packed, staged and handed to the delivery driver.",
        "returns": "Items brought back by delivery drivers wait here for inspection.",
    }
    areas = sections(block, desk, layout["sales_floor"].buffer(3.0, join_style="mitre").buffer(-3.0, join_style="mitre"),
                     building_angle(layout["sales_floor"]))
    building = outer_wall(layout, list(areas.values()))
    door_note = ("The store map marks only the customer entrances at the front, so this door is placed "
                 "on the area's outside wall.")
    for kind, area in areas.items():
        racks = sorted(part_to_rack[(r["feature"], r["part"])] for r in group
                       if (r["feature"], r["part"]) in part_to_rack and area.contains(r["poly"].representative_point()))
        anchor = desk if kind == "receiving" else area.representative_point()
        others = [other for other_kind, other in areas.items() if other_kind != kind]
        door = (place_door(kind, area, building, desk if source == "map_marker" else None, layout["sales_floor"], others)
                if kind in DOORS else None)
        if door is None and kind in DOORS:
            print(f"{store_id}: no outer wall long enough for the {kind} door")
        result["zones"].append({
            "id": f"{PREFIX[kind]}-{store_id}",
            "type": kind,
            "name": NAMES[kind],
            "source": source,
            "note": f"{purpose[kind]} {origin} Back-of-house section ({round(SHARES[kind] * 100)}% of the back room).",
            "anchor": to_lonlat(proj, anchor.x, anchor.y),
            "area_m2": round(area.area),
            "size_m": sorted([round(area.bounds[2] - area.bounds[0], 1), round(area.bounds[3] - area.bounds[1], 1)], reverse=True),
            "rack_ids": racks,
            "polygon": [to_lonlat(proj, x, y) for x, y in area.exterior.coords],
            "door": None if door is None else {
                "id": f"DOOR-{PREFIX[kind]}-{store_id}",
                "name": door["name"],
                "source": "inferred",
                "note": door_note,
                "width_m": door["width_m"],
                "position": to_lonlat(proj, door["centre"].x, door["centre"].y),
                "opening": [to_lonlat(proj, pt.x, pt.y) for pt in door["opening"]],
                "outside": to_lonlat(proj, door["centre"].x + 2 * door["outward"][0], door["centre"].y + 2 * door["outward"][1]),
            },
        })
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--stores", help="Comma-separated store IDs (default: all with map data)")
    args = parser.parse_args()
    wanted = set(args.stores.split(",")) if args.stores else None
    store_dirs = sorted(p for p in STORES_DIR.iterdir() if p.is_dir() and (p / "rack.geojson").is_file())
    layouts = {d.name: store_layout(d) for d in store_dirs}
    # Where the receiving desk sits within its building, for stores that lack one.
    templates = [{"store_id": sid, "size": size(layout), "relative": relative(layout["points"][DESK_ICON], layout["bounds"])}
                 for sid, layout in layouts.items() if DESK_ICON in layout["points"]]
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for store_dir in store_dirs:
        if wanted and store_dir.name not in wanted:
            continue
        result = build(store_dir, layouts[store_dir.name], templates)
        path = OUTPUT_DIR / f"{store_dir.name}.json"
        path.write_text(json.dumps(result, indent=1) + "\n", encoding="utf-8")
        summary = ", ".join(f"{z['type']} {z['area_m2']} m2 / {len(z['rack_ids'])} racks{' + door' if z['door'] else ''}"
                            for z in result["zones"])
        print(f"{store_dir.name}: {summary} ({result['zones'][0]['source'] if result['zones'] else '-'}) -> {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
