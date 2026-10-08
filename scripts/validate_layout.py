#!/usr/bin/env python
"""
Validate one or all layout JSON files under data/layouts/.

Usage:
    python scripts/validate_layout.py            # validate every layout
    python scripts/validate_layout.py 1665       # validate a single store_id
"""
from __future__ import annotations

import sys
from pathlib import Path

# Allow running as `python scripts/validate_layout.py` from the project root.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import georeference, layout_service, store_service  # noqa: E402
from backend.config import LAYOUTS_DIR  # noqa: E402


def validate_one(store_id: str) -> bool:
    try:
        layout = layout_service.get_raw_layout(store_id)
    except Exception as exc:  # noqa: BLE001 - report to user, don't crash
        print(f"[FAIL] {store_id}: {exc}")
        return False

    counts = (
        f"departments={len(layout.departments)} "
        f"aisles={len(layout.aisles)} "
        f"racks={len(layout.racks)} "
        f"markers={len(layout.markers)}"
    )
    print(f"[OK]   {store_id}: {counts}")
    return True


def main() -> int:
    if not LAYOUTS_DIR.exists():
        print(f"Layouts directory does not exist: {LAYOUTS_DIR}")
        return 1

    if len(sys.argv) > 1:
        ids = [sys.argv[1]]
    else:
        ids = layout_service.list_layout_ids()

    if not ids:
        print("No layout files found.")
        return 1

    results = [validate_one(store_id) for store_id in ids]

    # Cross-check against the store directory too, if it's readable.
    try:
        stores = {s.store_id: s for s in store_service.list_stores()}
        layout_ids = set(layout_service.list_layout_ids())
        for store_id, store in stores.items():
            if store.layout_id not in layout_ids:
                print(f"[FAIL] store {store_id}: missing layout_id {store.layout_id!r}")
                results.append(False)
    except Exception as exc:  # noqa: BLE001
        print(f"[WARN] could not cross-check stores.json: {exc}")

    try:
        georeference.validate_all_buildings()
        print("[OK]   building footprints (data/buildings/*.geojson)")
    except Exception as exc:  # noqa: BLE001
        print(f"[FAIL] building footprints: {exc}")
        results.append(False)

    try:
        georeference.validate_all_georeference()
        print("[OK]   georeference control points (data/georeference/*.json)")
    except Exception as exc:  # noqa: BLE001
        print(f"[FAIL] georeference control points: {exc}")
        results.append(False)

    ok = all(results)
    print("\nRESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
