#!/usr/bin/env python
"""
Convert a local-coordinate floor layout (data/layouts/<store_id>.json) into
plain geographic GeoJSON files, without going through the running API.

Useful for offline inspection, QA in a GIS tool (QGIS, geojson.io), or
batch pre-generation of geographic layouts for many stores.

Usage:
    python scripts/convert_layout.py 1665
    python scripts/convert_layout.py 1665 --out out_dir/
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import layout_service  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("store_id", help="Store ID whose layout to convert")
    parser.add_argument(
        "--out",
        default="converted",
        help="Output directory for the geographic GeoJSON files (default: ./converted)",
    )
    args = parser.parse_args()

    try:
        geo = layout_service.get_geo_layout(args.store_id)
    except Exception as exc:  # noqa: BLE001
        print(f"Error converting layout {args.store_id!r}: {exc}")
        return 1

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    for kind in ("departments", "aisles", "racks", "markers"):
        out_path = out_dir / f"{args.store_id}_{kind}.geojson"
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(geo[kind], f, indent=2)
        print(f"Wrote {out_path} ({len(geo[kind]['features'])} features)")

    combined_path = out_dir / f"{args.store_id}_combined.geojson"
    combined = {
        "type": "FeatureCollection",
        "features": (
            geo["departments"]["features"]
            + geo["aisles"]["features"]
            + geo["racks"]["features"]
            + geo["markers"]["features"]
        ),
    }
    with open(combined_path, "w", encoding="utf-8") as f:
        json.dump(combined, f, indent=2)
    print(f"Wrote {combined_path} ({len(combined['features'])} features total)")
    print(f"Anchor: {geo['anchor']}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
