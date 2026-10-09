"""Generate sample online orders for the order-picking module.

Writes ``frontend/data/orders/<store_id>.json`` with 15 orders and the
starting state of three picking carts. Every order line reuses an existing
inventory SKU and its rack (``frontend/data/inventory/<store_id>.json``), so
products have exactly one location and it is the same one the Rack Inventory
panel shows. Only racks whose picking access point is reachable from the
PRODUCT PICK-UP desk on the walking network are used
(``frontend/data/routing/<store_id>.json``).

Usage:  python scripts/generate_sample_orders.py [--stores 1665,2544]
"""
from __future__ import annotations

import argparse
import base64
import json
import random
from collections import deque
from datetime import datetime, timedelta, timezone

import numpy as np

from generate_inventory import OUTPUT_DIR as INVENTORY_DIR, ROOT, STORES_DIR, UNASSIGNED

ROUTING_DIR = ROOT / "frontend" / "data" / "routing"
OUTPUT_DIR = ROOT / "frontend" / "data" / "orders"
ORDER_COUNT = 15

# Order item type -> (inventory product name, quantity range). Types without a
# product in the store inventory (e.g. door handles) are not offered.
PRODUCT_TYPES = {
    "Cordless Drill": ("20V Cordless Drill/Driver Kit", (1, 2)),
    "Hammer": ("16 oz Claw Hammer", (1, 3)),
    "LED Bulbs": ("LED A19 Bulb (4-Pack)", (1, 6)),
    "PEX Pipe": ("1/2 in PEX Pipe, 100 ft", (1, 3)),
    "Wall Paint": ("Interior Eggshell Paint, 1 gal", (1, 4)),
    "Paint Roller": ("9 in Roller Kit", (1, 3)),
    "Electrical Wire": ("14/2 NM-B Wire, 50 ft", (1, 3)),
    "Screwdriver Set": ("Screwdriver Set (10-Piece)", (1, 2)),
    "Garden Hose": ("50 ft Garden Hose", (1, 2)),
    "Storage Containers": ("27 gal Storage Tote", (1, 4)),
    "Wood Screws": ("Deck Screws #8 x 2-1/2 in, 5 lb", (1, 3)),
    "Floor Tiles": ("Porcelain Tile 12x24 (Case)", (2, 6)),
    "Plumbing Fittings": ("PVC 90-Degree Elbow (10-Pack)", (1, 4)),
    "Safety Gloves": ("Work Gloves (3-Pack)", (1, 4)),
}
CARTS = [
    {"cart_id": "CART-01", "name": "Cart 01", "color": "#2563eb", "picker": "M. Johnson"},
    {"cart_id": "CART-02", "name": "Cart 02", "color": "#7c3aed", "picker": "S. Patel"},
    {"cart_id": "CART-03", "name": "Cart 03", "color": "#ea580c", "picker": "D. Garcia"},
]
STARTING_ASSIGNMENTS = {"CART-01": ["ORD-1001", "ORD-1002", "ORD-1003"], "CART-02": ["ORD-1004", "ORD-1005"], "CART-03": []}


def reachable_cells(network: dict) -> set[int] | None:
    """Cells connected (8-way, no corner cutting) to the pick-up desk."""
    grid, pickup = network["grid"], network.get("pickup")
    if not pickup or pickup.get("cell") is None:
        return None
    cols, rows = grid["cols"], grid["rows"]
    bits = np.unpackbits(np.frombuffer(base64.b64decode(grid["mask"]), dtype=np.uint8), bitorder="little")[: cols * rows]
    walkable = bits.astype(bool)
    seen = {pickup["cell"]}
    queue = deque([pickup["cell"]])
    while queue:
        cell = queue.popleft()
        r, c = divmod(cell, cols)
        for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nr, nc = r + dr, c + dc
            n = nr * cols + nc
            if 0 <= nr < rows and 0 <= nc < cols and walkable[n] and n not in seen:
                seen.add(n)
                queue.append(n)
    return seen


def product_pool(inventory: dict, network: dict) -> list[dict]:
    """One stocked, reachable location (rack + SKU) per order item type."""
    reachable = reachable_cells(network) or set()
    access = network["rack_access"]
    pool = []
    for item_type, (product_name, _) in PRODUCT_TYPES.items():
        candidates = []
        for rack in inventory["racks"]:
            if access.get(rack["rack_id"]) not in reachable:
                continue
            for product in rack["products"]:
                if product["product_name"] == product_name and product["stock_quantity"] >= 12:
                    candidates.append((rack["department"] != UNASSIGNED, rack["aisle_id"] is not None, product["stock_quantity"], rack, product))
        if not candidates:
            continue
        *_, rack, product = max(candidates, key=lambda c: c[:3])
        pool.append({"type": item_type, "product_name": product_name, "sku": product["sku"], "rack_id": rack["rack_id"],
                     "aisle_id": rack["aisle_id"], "department": rack["department"], "max_quantity": PRODUCT_TYPES[item_type][1][1]})
    return pool


def generate(store_id: str) -> dict | None:
    inventory_path, routing_path = INVENTORY_DIR / f"{store_id}.json", ROUTING_DIR / f"{store_id}.json"
    if not inventory_path.is_file() or not routing_path.is_file():
        return None
    inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
    network = json.loads(routing_path.read_text(encoding="utf-8"))
    pool = product_pool(inventory, network)
    if len(pool) < 8:
        print(f"{store_id}: only {len(pool)} reachable product locations; skipped")
        return None
    rng = random.Random(f"lowes-sample-orders-{store_id}")
    start = datetime(2026, 10, 9, 7, 5, tzinfo=timezone.utc)
    orders = []
    for n in range(ORDER_COUNT):
        items = rng.sample(pool, k=rng.randint(2, min(8, len(pool))))
        lines = []
        for line_no, item in enumerate(items, start=1):
            low, high = PRODUCT_TYPES[item["type"]][1]
            lines.append({"line_no": line_no, "type": item["type"], "product_name": item["product_name"], "sku": item["sku"],
                          "quantity": rng.randint(low, high), "rack_id": item["rack_id"], "aisle_id": item["aisle_id"],
                          "department": item["department"]})
        placed = start + timedelta(minutes=n * 11 + rng.randint(0, 9))
        orders.append({
            "order_id": f"ORD-{1001 + n}",
            "customer_ref": f"CUST-{rng.randint(10000, 99999)}",
            "order_time": placed.isoformat().replace("+00:00", "Z"),
            "priority": rng.choices(["High", "Normal", "Low"], weights=[3, 6, 2])[0],
            "lines": lines,
        })
    return {
        "simulated": True,
        "notice": "Sample online orders - not from any live Lowe's order system.",
        "store_id": store_id,
        "generated_at": "2026-10-09T12:00:00Z",
        "product_pool": pool,
        "orders": orders,
        "carts": [{**cart, "orders": STARTING_ASSIGNMENTS[cart["cart_id"]]} for cart in CARTS],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--stores", help="Comma-separated store IDs (default: all with inventory + routing data)")
    args = parser.parse_args()
    wanted = set(args.stores.split(",")) if args.stores else None
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for store_dir in sorted(p for p in STORES_DIR.iterdir() if p.is_dir()):
        if wanted and store_dir.name not in wanted:
            continue
        result = generate(store_dir.name)
        if not result:
            continue
        path = OUTPUT_DIR / f"{store_dir.name}.json"
        path.write_text(json.dumps(result, indent=1) + "\n", encoding="utf-8")
        skus = [line["sku"] for order in result["orders"] for line in order["lines"]]
        shared = sum(1 for sku in set(skus) if skus.count(sku) > 1)
        print(f"{store_dir.name}: {len(result['orders'])} orders, {len(skus)} lines, {len(result['product_pool'])} product locations "
              f"({shared} shared by several orders) -> {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
