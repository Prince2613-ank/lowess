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
  block is the outline of that group plus the desk, kept off the sales floor.
* The block is divided along its length into three sections, each keeping its
  racks as that area's shelving (``rack_ids``):
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

Writes ``frontend/data/zones/<store_id>.json`` in source coordinates (the
browser aligns them like the map). Map GeoJSON is never modified.

Usage:  python scripts/build_store_zones.py [--stores 1665,2544]
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from shapely.geometry import Point, box
from shapely.ops import unary_union

from generate_inventory import OUTPUT_DIR as INVENTORY_DIR, ROOT, STORES_DIR, StoreGeometry, load

OUTPUT_DIR = ROOT / "frontend" / "data" / "zones"
DESK_ICON = "receiving_desk"
RACK_GAP = 4.0          # m: back-room racks this close belong to one group
MIN_GROUP = 15          # racks: smallest back-room group used for an inferred position
SHARES = {"receiving": 0.5, "dispatch": 0.3, "returns": 0.2}
NAMES = {"receiving": "Receiving Area", "dispatch": "Pack & Dispatch", "returns": "Returns Area"}
PREFIX = {"receiving": "RCV", "dispatch": "DSP", "returns": "RTN"}


def store_layout(store_dir: Path) -> dict:
    geometry = StoreGeometry(store_dir)
    points = {f["properties"]["icon_id"]: Point(geometry.proj.xy(*f["geometry"]["coordinates"][:2]))
              for f in load(store_dir, "department") if (f.get("properties") or {}).get("icon_id")}
    sales_floor = unary_union([poly for poly, _ in geometry.departments])
    back_room = [r for r in geometry.racks if r["poly"].intersection(sales_floor).area < 0.2 * r["poly"].area]
    return {"geometry": geometry, "proj": geometry.proj, "points": points, "sales_floor": sales_floor,
            "back_room": back_room, "bounds": sales_floor.bounds}


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
    outline = unary_union(parts).convex_hull.buffer(1.0, join_style="mitre").difference(layout["sales_floor"])
    pieces = sorted(getattr(outline, "geoms", [outline]), key=lambda piece: (round(piece.distance(desk), 1), -piece.area))
    return pieces[0].simplify(0.2), group


def sections(block, desk: Point) -> dict:
    """Split the block along its long axis: Receiving around the desk, Pack &
    Dispatch next to it, Returns beyond (or on the other side)."""
    minx, miny, maxx, maxy = block.bounds
    along_x = (maxx - minx) >= (maxy - miny)
    lo, hi = (minx, maxx) if along_x else (miny, maxy)
    span = hi - lo
    at = min(max(((desk.x if along_x else desk.y) - lo) / span, 0.0), 1.0)
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
        cut = box(lo + a * span, miny, lo + b * span, maxy) if along_x else box(minx, lo + a * span, maxx, lo + b * span)
        part = block.intersection(cut)
        if not part.is_empty:
            out[kind] = max(getattr(part, "geoms", [part]), key=lambda piece: piece.area)
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
    for kind, area in sections(block, desk).items():
        racks = sorted(part_to_rack[(r["feature"], r["part"])] for r in group
                       if (r["feature"], r["part"]) in part_to_rack and area.contains(r["poly"].representative_point()))
        anchor = desk if kind == "receiving" else area.representative_point()
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
        summary = ", ".join(f"{z['type']} {z['area_m2']} m2 / {len(z['rack_ids'])} racks" for z in result["zones"])
        print(f"{store_dir.name}: {summary} ({result['zones'][0]['source'] if result['zones'] else '-'}) -> {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
