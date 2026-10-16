"""Build the Store Comparison data: one record per store for the dashboard.

Measured from each store's own data:
  * inventory  - racks, SKUs, units on hand, rack occupancy, out-of-stock SKUs
                 (0 units) and low-stock SKUs (at or below the reorder point),
                 from frontend/data/inventory/<id>.json;
  * layout     - walking distance (m) on the store's walking network from Pack &
                 Dispatch to every reachable rack (mean and 90th percentile),
                 from frontend/data/routing/<id>.json.

Order history is simulated (there is no live order system), 180 days per store,
derived from those measurements so stores differ for real reasons:
  * order volume   - scales with store size (racks), weekly pattern (busier at
                     weekends), gentle trend and day-to-day noise;
  * fulfillment    - an order ships complete unless one of its lines is short;
                     the chance a line is short follows the store's out-of-stock
                     share;
  * productivity   - labour time per order = handling per unit + packing + the
                     walk, which follows the store's walking distance; reported
                     as units picked per labour hour.
Seeded by store id, so a rebuild gives the same history (dates end on the build
date).

Writes frontend/data/metrics/stores.json.

Usage:  python scripts/build_store_metrics.py
"""
from __future__ import annotations

import base64
import json
import math
import random
from collections import deque
from datetime import date, timedelta

import numpy as np

from generate_inventory import OUTPUT_DIR as INVENTORY_DIR, ROOT, STORES_DIR

ROUTING_DIR = ROOT / "frontend" / "data" / "routing"
OUTPUT = ROOT / "frontend" / "data" / "metrics" / "stores.json"
DAYS = 180
WEEKDAY = [0.88, 0.86, 0.9, 0.95, 1.08, 1.32, 1.21]   # Mon..Sun order volume
UNITS_PER_ORDER = 4.2
LINES_PER_ORDER = 3.3
HANDLING_S = 30          # per unit: find, scan, place in the tote
PACKING_S = 95           # per order at Pack & Dispatch
BATCH = 3                # orders per cart trip
WALK_SPEED = 1.0         # m/s with a cart
ROUTE_FACTOR = 1.6       # a multi-stop trip vs. out-and-back to the mean rack


def walk_distances(network: dict) -> list[float]:
    """Walking distance (m) from Pack & Dispatch to each reachable rack."""
    grid = network["grid"]
    cols, rows, cell = grid["cols"], grid["rows"], grid["cell"]
    walkable = np.unpackbits(np.frombuffer(base64.b64decode(grid["mask"]), dtype=np.uint8), bitorder="little")[: cols * rows]
    start = (network.get("dispatch") or {}).get("cell")
    if start is None:
        return []
    dist = np.full(cols * rows, -1, dtype=np.int32)
    dist[start] = 0
    queue = deque([start])
    while queue:
        current = queue.popleft()
        r, c = divmod(current, cols)
        for nr, nc in ((r + 1, c), (r - 1, c), (r, c + 1), (r, c - 1)):
            if 0 <= nr < rows and 0 <= nc < cols:
                nxt = nr * cols + nc
                if walkable[nxt] and dist[nxt] < 0:
                    dist[nxt] = dist[current] + 1
                    queue.append(nxt)
    return [float(dist[c]) * cell for c in network["rack_access"].values() if c is not None and dist[c] >= 0]


def inventory_summary(inventory: dict) -> dict:
    racks = inventory["racks"]
    products = [p for rack in racks for p in rack["products"]]
    capacity = sum(rack["storage_capacity"] for rack in racks)
    occupied = sum(rack["occupied_capacity"] for rack in racks)
    return {
        "racks": len(racks),
        "skus": len(products),
        "units": sum(p["stock_quantity"] for p in products),
        "occupancy_pct": round(100 * occupied / capacity, 1) if capacity else 0.0,
        "vacant_racks": sum(rack["occupancy_percentage"] == 0 for rack in racks),
        "out_of_stock": sum(p["stock_quantity"] == 0 for p in products),
        "low_stock": sum(0 < p["stock_quantity"] <= p["reorder_point"] for p in products),
    }


def simulate(store_id: str, inv: dict, walk_mean: float, end: date) -> dict:
    rng = random.Random(f"store-metrics-{store_id}")
    base = (38 + 0.032 * inv["racks"]) * rng.uniform(0.82, 1.22)      # orders / day
    trend = rng.uniform(-0.0006, 0.0018)                                # per day
    oos_share = inv["out_of_stock"] / max(1, inv["skus"])
    line_short = 0.065 * oos_share * rng.uniform(0.85, 1.15)            # a line is short-picked
    crew = rng.uniform(0.92, 1.08)                                      # staff pace
    walk_per_order = 2 * walk_mean * ROUTE_FACTOR / BATCH / WALK_SPEED  # s
    daily = {"date": [], "orders": [], "units": [], "complete": [], "labour_min": []}
    for i in range(DAYS):
        day = end - timedelta(days=DAYS - 1 - i)
        expected = base * WEEKDAY[day.weekday()] * (1 + trend * (i - DAYS))
        orders = max(0, round(rng.gauss(expected, expected * 0.09)))
        units = max(orders, round(orders * rng.gauss(UNITS_PER_ORDER, 0.25)))
        p_complete = (1 - line_short) ** LINES_PER_ORDER
        complete = sum(rng.random() < p_complete for _ in range(orders))
        seconds = (units * HANDLING_S + orders * (PACKING_S + walk_per_order)) / crew * rng.gauss(1.0, 0.06)
        daily["date"].append(day.isoformat())
        daily["orders"].append(orders)
        daily["units"].append(units)
        daily["complete"].append(complete)
        daily["labour_min"].append(round(seconds / 60, 1))
    return daily


def main() -> None:
    end = date.today()
    stores = []
    for store_dir in sorted(p for p in STORES_DIR.iterdir() if (p / "rack.geojson").is_file()):
        sid = store_dir.name
        inventory_path, routing_path = INVENTORY_DIR / f"{sid}.json", ROUTING_DIR / f"{sid}.json"
        if not inventory_path.is_file() or not routing_path.is_file():
            continue
        store = json.loads((store_dir / "store.json").read_text(encoding="utf-8"))
        inv = inventory_summary(json.loads(inventory_path.read_text(encoding="utf-8")))
        walks = sorted(walk_distances(json.loads(routing_path.read_text(encoding="utf-8"))))
        walk_mean = sum(walks) / len(walks) if walks else 0.0
        stores.append({
            "store_id": sid,
            "name": store.get("name", f"Store {sid}"),
            "city": store.get("city", ""),
            "latitude": store.get("latitude"),
            "longitude": store.get("longitude"),
            "inventory": inv,
            "layout": {"walk_mean_m": round(walk_mean, 1),
                       "walk_p90_m": round(walks[int(0.9 * (len(walks) - 1))], 1) if walks else 0.0,
                       "racks_reachable": len(walks)},
            "daily": simulate(sid, inv, walk_mean, end),
        })
        latest = stores[-1]["daily"]
        print(f"{sid}: {inv['racks']} racks, {inv['out_of_stock']} out of stock, walk {walk_mean:.0f} m, "
              f"{sum(latest['orders'][-30:])} orders / 30 days")
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps({
        "version": 1,
        "end_date": end.isoformat(),
        "days": DAYS,
        "simulated": ["daily"],
        "notice": "Inventory and walking distances are measured from each store's data; order history is simulated.",
        "stores": stores,
    }, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"-> {OUTPUT.relative_to(ROOT)} ({OUTPUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
