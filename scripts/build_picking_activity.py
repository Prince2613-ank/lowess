"""Picking activity per store, for the Activity tab's heatmap.

Two layers, both from the simulated history:
  * rack picks   - weekly pick lines per rack for the last 12 weeks: each SKU's
                   weekly sales (frontend/data/forecast/<id>.json) x the online
                   share, in lines of ~1.27 units (4.2 units / 3.3 lines per order);
  * cart traffic - cart trips simulated on the store's walking network
                   (frontend/data/routing/<id>.json): orders batched 3 to a cart,
                   their lines drawn by rack pick frequency, visited nearest-first
                   from Pack & Dispatch and back. Each leg is the shortest walk on
                   the grid (8-way moves, a small cost for hugging shelving so
                   carts keep to aisle centres - as the live routes do). Visits are
                   counted per 1 m cell and scaled to cart passes per week.

Writes frontend/data/activity/<store_id>.json (source coordinates; the browser
aligns them like the rest of the store map).

Usage:  python scripts/build_picking_activity.py [--stores 2383]
"""
from __future__ import annotations

import argparse
import base64
import heapq
import json
import math
import random
from collections import deque

import numpy as np

from generate_inventory import OUTPUT_DIR as INVENTORY_DIR, ROOT

FORECAST_DIR = ROOT / "frontend" / "data" / "forecast"
ROUTING_DIR = ROOT / "frontend" / "data" / "routing"
METRICS = ROOT / "frontend" / "data" / "metrics" / "stores.json"
OUTPUT_DIR = ROOT / "frontend" / "data" / "activity"
UNITS_PER_LINE = 4.2 / 3.3
ORDERS_PER_TRIP = 3
LINES_PER_ORDER = 3.3
TRIPS = 400
CENTRE_WEIGHT = 0.4       # as the live routes: step cost x (1 + 0.4 / clearance)
MAX_CLEARANCE = 80
HEAT_CELL = 2             # grid cells per heat cell side (0.5 m -> 1 m)
SQRT2 = math.sqrt(2)


class Walk:
    """Shortest walks on a store's walking grid (A*, 8-way, centre-weighted)."""

    def __init__(self, network: dict):
        grid = network["grid"]
        self.cols, self.rows, self.cell = grid["cols"], grid["rows"], grid["cell"]
        self.x0, self.y0 = grid["x0"], grid["y0"]
        mask = np.unpackbits(np.frombuffer(base64.b64decode(grid["mask"]), dtype=np.uint8), bitorder="little")[: self.cols * self.rows]
        self.walkable = mask.astype(bool)
        self.clearance = self._clearance()
        self.step = 1 + CENTRE_WEIGHT / np.maximum(self.clearance, 1)

    def _clearance(self) -> np.ndarray:
        """Cells to the nearest blocked cell (multi-source BFS)."""
        cols, n = self.cols, self.cols * self.rows
        dist = np.full(n, MAX_CLEARANCE, dtype=np.int32)
        queue = deque()
        for i in np.flatnonzero(~self.walkable):
            dist[i] = 0
            queue.append(int(i))
        while queue:
            current = queue.popleft()
            if dist[current] >= MAX_CLEARANCE:
                continue
            r, c = divmod(current, cols)
            for nr, nc in ((r + 1, c), (r - 1, c), (r, c + 1), (r, c - 1)):
                if 0 <= nr < self.rows and 0 <= nc < cols:
                    nxt = nr * cols + nc
                    if dist[nxt] > dist[current] + 1:
                        dist[nxt] = dist[current] + 1
                        queue.append(nxt)
        return dist

    def octile(self, a: int, b: int) -> float:
        ar, ac = divmod(a, self.cols)
        br, bc = divmod(b, self.cols)
        dr, dc = abs(ar - br), abs(ac - bc)
        return max(dr, dc) + (SQRT2 - 1) * min(dr, dc)

    def path(self, start: int, goal: int) -> list[int]:
        if start == goal:
            return [start]
        cols, rows, walkable, step = self.cols, self.rows, self.walkable, self.step
        gr, gc = divmod(goal, cols)
        best = {start: 0.0}
        came = {}
        heap = [(self.octile(start, goal), 0.0, start)]
        while heap:
            _, cost, current = heapq.heappop(heap)
            if current == goal:
                out = [current]
                while current in came:
                    current = came[current]
                    out.append(current)
                return out[::-1]
            if cost > best.get(current, math.inf):
                continue
            r, c = divmod(current, cols)
            for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
                nr, nc = r + dr, c + dc
                if not (0 <= nr < rows and 0 <= nc < cols):
                    continue
                nxt = nr * cols + nc
                if not walkable[nxt]:
                    continue
                diagonal = dr and dc
                if diagonal and not (walkable[r * cols + nc] and walkable[nr * cols + c]):
                    continue                                   # no cutting shelf corners
                new = cost + (SQRT2 if diagonal else 1.0) * 0.5 * (step[current] + step[nxt])
                if new < best.get(nxt, math.inf):
                    best[nxt] = new
                    came[nxt] = current
                    heapq.heappush(heap, (new + max(abs(nr - gr), abs(nc - gc)) + (SQRT2 - 1) * min(abs(nr - gr), abs(nc - gc)), new, nxt))
        return []

    def length_m(self, path: list[int]) -> float:
        total = 0.0
        for a, b in zip(path, path[1:]):
            total += SQRT2 if (a // self.cols != b // self.cols and a % self.cols != b % self.cols) else 1.0
        return total * self.cell


def rack_weekly_lines(forecast: dict) -> dict[str, np.ndarray]:
    share = forecast.get("online_share", 0.1)
    racks: dict[str, np.ndarray] = {}
    for sku, rack_id, *_rest, weekly in forecast["skus"]:
        lines = np.array(weekly, dtype=float) * share / UNITS_PER_LINE
        racks[rack_id] = racks.get(rack_id, 0) + lines
    return racks


def build(store_id: str, metrics_store: dict) -> dict | None:
    paths = [FORECAST_DIR / f"{store_id}.json", ROUTING_DIR / f"{store_id}.json", INVENTORY_DIR / f"{store_id}.json"]
    if not all(p.is_file() for p in paths):
        return None
    forecast, network, _ = (json.loads(p.read_text(encoding="utf-8")) for p in paths)
    rng = random.Random(f"picking-activity-{store_id}")
    weekly = rack_weekly_lines(forecast)
    access = network["rack_access"]
    dispatch = (network.get("dispatch") or {}).get("cell")
    walk = Walk(network)

    # Weekly pick lines per rack (rounded; the rack heat in the browser).
    rack_lines = {rack: [int(round(v)) for v in values] for rack, values in weekly.items()}
    # Trips: lines drawn by pick frequency among racks the carts can reach.
    reachable = [r for r, v in weekly.items() if access.get(r) is not None and v.sum() > 0]
    weights = [float(weekly[r].sum()) for r in reachable]
    counts = np.zeros(walk.cols * walk.rows, dtype=np.float64)
    trip_lengths = []
    if dispatch is not None and reachable:
        for _ in range(TRIPS):
            lines = sum(max(1, round(rng.gauss(LINES_PER_ORDER, 1.2))) for _ in range(ORDERS_PER_TRIP))
            stops = list(dict.fromkeys(access[r] for r in rng.choices(reachable, weights=weights, k=lines)))
            here, route, total = dispatch, [], 0.0
            while stops:
                nxt = min(stops, key=lambda cell: walk.octile(here, cell))
                stops.remove(nxt)
                leg = walk.path(here, nxt)
                route.extend(leg[1:] if route else leg)
                here = nxt
            back = walk.path(here, dispatch)
            route.extend(back[1:])
            trip_lengths.append(walk.length_m(route))
            np.add.at(counts, np.array(route, dtype=np.int64), 1)

    # Scale to cart passes per week and pool into 1 m heat cells.
    orders_per_week = sum(metrics_store["daily"]["orders"][-84:]) / 12
    trips_per_week = orders_per_week / ORDERS_PER_TRIP
    scale = trips_per_week / max(1, len(trip_lengths))
    grid = (counts.reshape(walk.rows, walk.cols) > 0) * counts.reshape(walk.rows, walk.cols)
    hr, hc = math.ceil(walk.rows / HEAT_CELL), math.ceil(walk.cols / HEAT_CELL)
    padded = np.zeros((hr * HEAT_CELL, hc * HEAT_CELL))
    padded[: walk.rows, : walk.cols] = grid
    pooled = padded.reshape(hr, HEAT_CELL, hc, HEAT_CELL).max(axis=(1, 3)) * scale
    proj = network["projection"]
    size = walk.cell * HEAT_CELL
    heat = []
    for r, c in zip(*np.nonzero(pooled)):
        x, y = walk.x0 + (c + 0.5) * size, walk.y0 + (r + 0.5) * size
        heat.append([round(proj["lon0"] + x / proj["kx"], 7), round(proj["lat0"] + y / proj["ky"], 7), round(float(pooled[r, c]), 1)])
    return {
        "version": 1,
        "store_id": store_id,
        "simulated": True,
        "notice": "Pick history and cart trips are simulated from the store's sales history and walking network.",
        "history_end": forecast["history_end"],
        "weeks": len(next(iter(rack_lines.values()))) if rack_lines else 0,
        "rack_lines": rack_lines,
        "traffic": {
            "cell_m": size,
            "unit": "cart passes per week",
            "trips_simulated": len(trip_lengths),
            "trips_per_week": round(trips_per_week, 1),
            "trip_m_mean": round(float(np.mean(trip_lengths)), 1) if trip_lengths else 0.0,
            "points": heat,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--stores", help="Comma-separated store IDs (default: all in the metrics data)")
    args = parser.parse_args()
    wanted = set(args.stores.split(",")) if args.stores else None
    metrics = json.loads(METRICS.read_text(encoding="utf-8"))
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for store in metrics["stores"]:
        sid = store["store_id"]
        if wanted and sid not in wanted:
            continue
        result = build(sid, store)
        if result is None:
            print(f"{sid}: missing forecast / routing / inventory data - skipped")
            continue
        path = OUTPUT_DIR / f"{sid}.json"
        path.write_text(json.dumps(result, separators=(",", ":")) + "\n", encoding="utf-8")
        t = result["traffic"]
        print(f"{sid}: {len(result['rack_lines'])} racks, {t['trips_simulated']} trips (mean {t['trip_m_mean']:.0f} m), "
              f"{len(t['points'])} heat cells -> {path.relative_to(ROOT)} ({path.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
