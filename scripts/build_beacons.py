"""Illustrative BLE beacon layout per store, for the Live Tracking tab.

Stage 1 of indoor positioning: a simulated beacon installation, so the store
map can show carts and staff positioned from Bluetooth signal strength (RSSI)
instead of GPS-like perfect positions. Per store:

* Beacons - 20 to 35, one per ~460 m2 of the building's footprint (about
  20 m apart; ~30 in a typical store - enough for ~2 m positioning, see below):
    one in each back-of-house area (Receiving, Pack & Dispatch, Returns),
    ceiling-mounted over open floor nearest the area's centre;
    the rest spread over the sales floor by k-means on the walkable floor
    (fixed back-of-house beacons as seeds), each moved onto the walkable cell
    nearest its cluster centre with at least 1 m of clearance - so every
    part of the floor has a beacon close by.
* Rack beacons - a small low-power beacon on the face of every rack carts can
  reach, just behind its pick point (the walkable cell in front of the rack).
  Heard strongly only from close by, they give a rack-level fix (under 1 m)
  wherever a cart or person stands at a rack; the ceiling beacons cover the rest.
* Zones for entry/exit events - every walkable cell of the store's walking
  grid labelled with the back-of-house area it lies in, else the department
  of the nearest rack within 5 m, else "Main aisles" (run-length encoded).
* Signal model - log-distance path loss with the beacon's measured power at
  1 m, the 3D distance to a ceiling-mounted beacon, and attenuation through
  shelving: the blocked grid cells on the receiver's end of the straight
  line to the beacon, where the signal path runs below the top of the racks.
  The browser adds shadowing and noise to every scan.
* Coverage - share of the walkable floor that hears 3+ beacons above the
  positioning threshold (mean signal, no noise).

Beacon positions are illustrative, not a real installation survey; Stage 3
(a hardware pilot) replaces them with surveyed positions and calibrated
measured power and path-loss values.

Writes frontend/data/beacons/<store_id>.json (source coordinates; the
browser aligns them like the rest of the store map).

Usage:  python scripts/build_beacons.py [--stores 1665]
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import random
from collections import deque

import numpy as np
import shapely

from shapely.geometry import Polygon

from generate_inventory import OUTPUT_DIR as INVENTORY_DIR, ROOT

ROUTING_DIR = ROOT / "frontend" / "data" / "routing"
ZONES_DIR = ROOT / "frontend" / "data" / "zones"
OUTPUT_DIR = ROOT / "frontend" / "data" / "beacons"
# Density: with one beacon per ~1,000 m2 (10-15 a store) the median error was
# 3.5-4 m; one per ~460 m2 (~30) brings it to ~2 m, close enough to tell racks
# apart (measured on the stores' walking networks, calibrated radio map).
M2_PER_BEACON = 460
MIN_BEACONS, MAX_BEACONS = 20, 35
MIN_CLEARANCE = 2          # cells (1 m) from shelving for a ceiling beacon over open floor
RACK_ZONE_M = 5.0          # m: cells this close to a rack take its department as their zone
KMEANS_ROUNDS = 30
COVERAGE_STEP = 2          # every 2nd cell (1 m) for the coverage figure
MODEL = {
    "tx_power_dbm": -55,            # measured power at 1 m (iBeacon convention), high-power setting
    "path_loss_exponent": 2.0,      # open-plan retail with a high ceiling
    "mount_height_m": 4.5,          # beacons on the ceiling
    "receiver_height_m": 1.1,       # cart handle / phone on a lanyard
    "shelving_height_m": 2.4,       # as the 3D view: signal from above clears the racks
    "shelving_db_per_m": 0.8,       # attenuation through stocked shelving
    "shelving_cap_db": 10,
    "shadowing_sigma_db": 3.0,      # slow fading per receiver-beacon pair
    "noise_sigma_db": 2.5,          # scan-to-scan noise
    "sensitivity_dbm": -100,        # weakest advertisement a receiver decodes
    "usable_dbm": -94,              # weakest signal used for positioning
    "advertising_interval_ms": 200,
    "scan_interval_s": 1.0,
}
# Rack beacons: low transmit power, mounted at cart height on the rack face.
RACK_MODEL = {
    "tx_power_dbm": -72,            # measured power at 1 m (proximity setting)
    "path_loss_exponent": 2.0,
    "shelving_db_per_m": 2.5,       # through the racks themselves, at shelf height
    "shelving_cap_db": 20,
    "shadowing_sigma_db": 1.5,      # short range, mostly line of sight
    "noise_sigma_db": 2.5,
    "advertising_interval_ms": 100,
    "heard_within_m": 10,           # weaker than this is ignored
    "fix_dbm": -79,                 # a rack beacon this strong: the receiver is at that rack (about 2 m or closer)
    "group_db": 4,                  # rack beacons within this of the strongest share the fix
}
RACK_MOUNT_M = 0.45                 # beacon behind the pick point, towards the rack
ZONE_NAMES = {"receiving": "Receiving Area", "dispatch": "Pack & Dispatch", "returns": "Returns Area"}
FALLBACK_ZONE = "Main aisles"
NO_DEPARTMENT = {"", "Unassigned"}      # racks the maps give no department: not a zone name


class Grid:
    """A store's walking grid (frontend/data/routing/<id>.json) in metres."""

    def __init__(self, network: dict):
        grid = network["grid"]
        self.cols, self.rows, self.cell = grid["cols"], grid["rows"], grid["cell"]
        self.x0, self.y0 = grid["x0"], grid["y0"]
        mask = np.unpackbits(np.frombuffer(base64.b64decode(grid["mask"]), dtype=np.uint8), bitorder="little")[: self.cols * self.rows]
        self.walkable = mask.astype(bool)
        self.projection = network["projection"]
        idx = np.arange(self.cols * self.rows)
        self.cx = self.x0 + (idx % self.cols + 0.5) * self.cell
        self.cy = self.y0 + (idx // self.cols + 0.5) * self.cell

    def xy(self, lon: float, lat: float) -> tuple[float, float]:
        p = self.projection
        return (lon - p["lon0"]) * p["kx"], (lat - p["lat0"]) * p["ky"]

    def lonlat(self, x: float, y: float) -> list[float]:
        p = self.projection
        return [round(p["lon0"] + x / p["kx"], 9), round(p["lat0"] + y / p["ky"], 9)]

    def reachable_from(self, start: int) -> np.ndarray:
        seen = np.zeros(self.walkable.size, dtype=bool)
        if start is None or not self.walkable[start]:
            return seen
        seen[start] = True
        queue = deque([start])
        cols, rows = self.cols, self.rows
        while queue:
            current = queue.popleft()
            r, c = divmod(current, cols)
            for nr, nc in ((r + 1, c), (r - 1, c), (r, c + 1), (r, c - 1)):
                if 0 <= nr < rows and 0 <= nc < cols:
                    nxt = nr * cols + nc
                    if self.walkable[nxt] and not seen[nxt]:
                        seen[nxt] = True
                        queue.append(nxt)
        return seen

    def clearance(self) -> np.ndarray:
        """Cells to the nearest blocked cell (multi-source BFS, capped at 10)."""
        cols, n = self.cols, self.walkable.size
        dist = np.full(n, 10, dtype=np.int32)
        queue = deque()
        for i in np.flatnonzero(~self.walkable):
            dist[i] = 0
            queue.append(int(i))
        while queue:
            current = queue.popleft()
            if dist[current] >= 10:
                continue
            r, c = divmod(current, cols)
            for nr, nc in ((r + 1, c), (r - 1, c), (r, c + 1), (r, c - 1)):
                if 0 <= nr < self.rows and 0 <= nc < cols:
                    nxt = nr * cols + nc
                    if dist[nxt] > dist[current] + 1:
                        dist[nxt] = dist[current] + 1
                        queue.append(nxt)
        return dist

    def blocked_m(self, bx: float, by: float, cells: np.ndarray, reach: float = 1.0) -> np.ndarray:
        """Metres of blocked grid (shelving, fixtures) on the line from each cell towards
        (bx, by), over the first `reach` of it (where the signal path is below rack height)."""
        tx, ty = self.cx[cells], self.cy[cells]
        length = np.hypot(tx - bx, ty - by) * reach
        samples = max(2, int(math.ceil(length.max() / self.cell)) + 1)
        t = np.linspace(0, reach, samples)[None, :]
        sx = tx[:, None] + (bx - tx[:, None]) * t
        sy = ty[:, None] + (by - ty[:, None]) * t
        c = np.floor((sx - self.x0) / self.cell).astype(np.int64)
        r = np.floor((sy - self.y0) / self.cell).astype(np.int64)
        inside = (c >= 0) & (r >= 0) & (c < self.cols) & (r < self.rows)
        flat = np.where(inside, r * self.cols + c, 0)
        blocked = inside & ~self.walkable[flat]
        return blocked.mean(axis=1) * length


def mean_rssi(grid: Grid, beacon: dict, cells: np.ndarray) -> np.ndarray:
    """Signal from a beacon at each cell: path loss over the 3D distance, plus shelving
    on the receiver's side of the path, where it runs below the top of the racks."""
    m = MODEL
    bx, by = beacon["xy"]
    horizontal = np.hypot(grid.cx[cells] - bx, grid.cy[cells] - by)
    drop = m["mount_height_m"] - m["receiver_height_m"]
    distance = np.sqrt(horizontal ** 2 + drop ** 2)
    reach = (m["shelving_height_m"] - m["receiver_height_m"]) / drop
    shelving = np.minimum(m["shelving_cap_db"], grid.blocked_m(bx, by, cells, reach) * m["shelving_db_per_m"])
    return beacon["tx_power_dbm"] + beacon["tx_offset_db"] - 10 * m["path_loss_exponent"] * np.log10(distance) - shelving


def rle(values: np.ndarray) -> list[int]:
    """[value, run, value, run, ...] in row-major cell order."""
    out, start = [], 0
    change = np.flatnonzero(np.diff(values)) + 1
    for end in [*change.tolist(), values.size]:
        out += [int(values[start]), int(end - start)]
        start = end
    return out


def zone_grid(grid: Grid, zones: list[dict], racks: list[dict]) -> tuple[list[str], np.ndarray]:
    """Zone label index per cell: back-of-house area, nearest rack's department, or main aisles."""
    labels = [FALLBACK_ZONE]
    index = np.zeros(grid.walkable.size, dtype=np.int32)       # 0 = main aisles (walkable) / unused
    walk = np.flatnonzero(grid.walkable)
    # Departments of the nearest rack (centroids), within RACK_ZONE_M.
    points = np.array([grid.xy(*rack["geometry_ref"]["source_centroid"]) for rack in racks])
    departments = [rack["department"] for rack in racks]
    for chunk in np.array_split(walk, max(1, walk.size // 2000)):
        dx = grid.cx[chunk, None] - points[None, :, 0]
        dy = grid.cy[chunk, None] - points[None, :, 1]
        dist = np.hypot(dx, dy)
        nearest = dist.argmin(axis=1)
        close = dist[np.arange(chunk.size), nearest] <= RACK_ZONE_M
        for cell, rack, ok in zip(chunk, nearest, close):
            if not ok:
                continue
            name = departments[rack]
            if name not in labels:
                labels.append(name)
            index[cell] = labels.index(name)
    # Back-of-house areas take precedence over the departments of their racks.
    for zone in zones:
        polygon = Polygon([grid.xy(*p) for p in zone["polygon"]])
        inside = shapely.contains_xy(polygon, grid.cx[walk], grid.cy[walk])
        name = ZONE_NAMES[zone["type"]]
        if inside.any():
            labels.append(name)
            index[walk[inside]] = len(labels) - 1
    return labels, index


def place_beacons(grid: Grid, zones: list[dict], floor: np.ndarray, clearance: np.ndarray, count: int, rng: random.Random) -> list[dict]:
    open_floor = floor & (clearance >= MIN_CLEARANCE)
    candidates = np.flatnonzero(open_floor) if open_floor.any() else np.flatnonzero(floor)
    fixed = []
    for zone in sorted(zones, key=lambda z: ["dispatch", "receiving", "returns"].index(z["type"])):
        polygon = Polygon([grid.xy(*p) for p in zone["polygon"]])
        centre = polygon.centroid
        inside = candidates[shapely.contains_xy(polygon, grid.cx[candidates], grid.cy[candidates])]
        pool = inside if inside.size else candidates
        best = pool[np.argmin(np.hypot(grid.cx[pool] - centre.x, grid.cy[pool] - centre.y))]
        fixed.append((int(best), zone))
    # k-means on the walkable floor with the back-of-house beacons held fixed.
    cells = np.flatnonzero(floor)
    pts = np.column_stack([grid.cx[cells], grid.cy[cells]])
    centres = [np.array([grid.cx[c], grid.cy[c]]) for c, _ in fixed]
    while len(centres) < count:                                    # farthest-point seeding
        dist = np.min([np.hypot(*(pts - c).T) for c in centres], axis=0) if centres else np.full(len(pts), 1.0)
        pick = rng.choices(range(len(pts)), weights=(dist ** 2).tolist(), k=1)[0]
        centres.append(pts[pick].copy())
    centres = np.array(centres)
    n_fixed = len(fixed)
    for _ in range(KMEANS_ROUNDS):
        assign = np.argmin(np.hypot(pts[:, None, 0] - centres[None, :, 0], pts[:, None, 1] - centres[None, :, 1]), axis=1)
        for k in range(n_fixed, count):
            members = pts[assign == k]
            if len(members):
                centres[k] = members.mean(axis=0)
    beacons = []
    used = set()
    for k in range(count):
        if k < n_fixed:
            cell, zone = fixed[k]
        else:
            free = candidates[[c not in used for c in candidates]]
            cell = int(free[np.argmin(np.hypot(grid.cx[free] - centres[k, 0], grid.cy[free] - centres[k, 1]))])
            zone = None
        used.add(cell)
        beacons.append({"cell": cell, "xy": [float(grid.cx[cell]), float(grid.cy[cell])], "zone": zone})
    return beacons


def rack_beacons(grid: Grid, network: dict, inventory: dict, floor: np.ndarray) -> list[list]:
    """[rack_id, x, y] (grid metres) for every rack with a pick point on the main floor."""
    centroids = {r["rack_id"]: grid.xy(*r["geometry_ref"]["source_centroid"]) for r in inventory["racks"] if r.get("geometry_ref", {}).get("source_centroid")}
    out = []
    for rack_id, cell in sorted(network["rack_access"].items()):
        if cell is None or not floor[cell] or rack_id not in centroids:
            continue
        ax, ay = float(grid.cx[cell]), float(grid.cy[cell])
        cx, cy = centroids[rack_id]
        d = math.hypot(cx - ax, cy - ay) or 1.0
        step = min(RACK_MOUNT_M, d)
        out.append([rack_id, round(ax + (cx - ax) / d * step, 2), round(ay + (cy - ay) / d * step, 2)])
    return out


def describe(grid: Grid, beacon: dict, racks: list[dict], points: np.ndarray) -> str:
    if beacon["zone"]:
        return ZONE_NAMES[beacon["zone"]["type"]]
    bx, by = beacon["xy"]
    rack = racks[int(np.argmin(np.hypot(points[:, 0] - bx, points[:, 1] - by)))]
    if rack.get("aisle_id"):
        return f"Aisle {rack['aisle_id']} · {rack['department']}"
    return f"{rack['department']} area"


def build(store_id: str) -> dict | None:
    paths = [ROUTING_DIR / f"{store_id}.json", ZONES_DIR / f"{store_id}.json", INVENTORY_DIR / f"{store_id}.json"]
    if not all(p.is_file() for p in paths):
        return None
    network, zones_payload, inventory = (json.loads(p.read_text(encoding="utf-8")) for p in paths)
    rng = random.Random(f"beacons-{store_id}")
    grid = Grid(network)
    zones = [z for z in zones_payload.get("zones", []) if z.get("type") in ZONE_NAMES]
    racks = [r for r in inventory["racks"] if r.get("geometry_ref", {}).get("source_centroid") and r.get("department") not in NO_DEPARTMENT]
    rack_points = np.array([grid.xy(*r["geometry_ref"]["source_centroid"]) for r in racks])
    dispatch = (network.get("dispatch") or {}).get("cell")
    floor = grid.reachable_from(dispatch) if dispatch is not None else grid.walkable.copy()
    clearance = grid.clearance()

    # Footprint: bounding box of everything mapped on the grid (walkable or not inside the store).
    walk = np.flatnonzero(grid.walkable)
    width = grid.cx[walk].max() - grid.cx[walk].min()
    depth = grid.cy[walk].max() - grid.cy[walk].min()
    count = int(min(MAX_BEACONS, max(MIN_BEACONS, round(width * depth / M2_PER_BEACON))))
    placed = place_beacons(grid, zones, floor, clearance, count, rng)

    beacons = []
    for i, beacon in enumerate(placed, start=1):
        beacon.update({"tx_power_dbm": MODEL["tx_power_dbm"], "tx_offset_db": round(rng.uniform(-2, 2), 1)})
        beacons.append({
            "id": f"BCN-{store_id}-{i:02d}",
            "name": f"B{i:02d}",
            "label": describe(grid, beacon, racks, rack_points),
            "zone_type": beacon["zone"]["type"] if beacon["zone"] else None,
            "position": grid.lonlat(*beacon["xy"]),
            "cell": beacon["cell"],
            "tx_power_dbm": beacon["tx_power_dbm"],
            # Simulated device-to-device spread in measured power; the positioning
            # engine assumes the nominal value (calibration removes it in a pilot).
            "tx_offset_db": beacon["tx_offset_db"],
            "battery_pct": rng.randint(58, 100),
            "_xy": beacon["xy"],
        })

    # Coverage on the walkable floor (every COVERAGE_STEP cells).
    rows, cols = np.divmod(np.flatnonzero(floor), grid.cols)
    sample = np.flatnonzero(floor)[(rows % COVERAGE_STEP == 0) & (cols % COVERAGE_STEP == 0)]
    heard = np.zeros(sample.size, dtype=np.int32)
    for beacon in beacons:
        heard += mean_rssi(grid, {"xy": beacon["_xy"], "tx_power_dbm": beacon["tx_power_dbm"], "tx_offset_db": beacon["tx_offset_db"]}, sample) >= MODEL["usable_dbm"]
    for beacon in beacons:
        del beacon["_xy"]

    labels, index = zone_grid(grid, zones, racks)
    racks_beacons = rack_beacons(grid, network, inventory, floor)
    return {
        "version": 1,
        "store_id": store_id,
        "simulated": True,
        "notice": "Illustrative beacon layout and simulated signals, not a surveyed installation.",
        "model": MODEL,
        "beacons": beacons,
        "rack_model": RACK_MODEL,
        "rack_beacons": racks_beacons,
        "zones": {"labels": labels, "cells": rle(index), "boh": {ZONE_NAMES[k]: k for k in ZONE_NAMES}},
        "coverage": {
            "floor_m2": round(float(floor.sum()) * grid.cell ** 2),
            "footprint_m": [round(float(width)), round(float(depth))],
            "share_3plus": round(float((heard >= 3).mean()), 3),
            "share_1plus": round(float((heard >= 1).mean()), 3),
            "mean_heard": round(float(heard.mean()), 1),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--stores", help="Comma-separated store IDs (default: every store with a walking network)")
    args = parser.parse_args()
    wanted = set(args.stores.split(",")) if args.stores else None
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for path in sorted(ROUTING_DIR.glob("*.json")):
        sid = path.stem
        if wanted and sid not in wanted:
            continue
        result = build(sid)
        if result is None:
            print(f"{sid}: missing routing / zones / inventory data - skipped")
            continue
        out = OUTPUT_DIR / f"{sid}.json"
        out.write_text(json.dumps(result, separators=(",", ":")) + "\n", encoding="utf-8")
        c = result["coverage"]
        print(f"{sid}: {len(result['beacons'])} ceiling + {len(result['rack_beacons'])} rack beacons over {c['footprint_m'][0]} x {c['footprint_m'][1]} m, "
              f"{c['share_3plus']:.0%} of the floor hears 3+ (mean {c['mean_heard']}), "
              f"{len(result['zones']['labels'])} zones -> {out.relative_to(ROOT)} ({out.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
