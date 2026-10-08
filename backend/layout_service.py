"""
Loads floor-layout JSON from data/layouts/ and produces both the raw
(local-coordinate) view and the transformed (geographic GeoJSON) view.

Security: layout files are only ever read from LAYOUTS_DIR, and the
store_id used to build the filename is validated against a strict
allow-list pattern (see store_service.validate_store_id) before it is
used in any path. Layout JSON itself is treated as untrusted data - it is
parsed and validated through Pydantic models, never executed.
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import List

from backend.config import LAYOUTS_DIR
from backend.models import Layout, Marker
from backend.store_service import validate_store_id
from backend.transform import geometry_to_geojson


class LayoutNotFoundError(Exception):
    pass


def _layout_path(store_id: str) -> Path:
    """Build a safe path under LAYOUTS_DIR for a validated store_id."""
    validate_store_id(store_id)
    path = (LAYOUTS_DIR / f"{store_id}.json").resolve()
    # Defense in depth: confirm the resolved path really is inside LAYOUTS_DIR.
    if LAYOUTS_DIR.resolve() not in path.parents:
        raise LayoutNotFoundError(f"Refusing to read outside layouts dir: {store_id!r}")
    return path


@lru_cache(maxsize=512)
def get_raw_layout(store_id: str) -> Layout:
    """Load and validate the raw (local-coordinate) layout for a store."""
    path = _layout_path(store_id)
    if not path.exists():
        raise LayoutNotFoundError(f"Layout not found for store_id: {store_id}")

    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)

    return Layout.model_validate(raw)


@lru_cache(maxsize=512)
def get_geo_layout(store_id: str) -> dict:
    """Return the geographic (lat/lon-transformed) version of a store's
    layout, as a plain dict of GeoJSON-flavored features grouped by kind.

    Cached: the (often expensive) coordinate transformation only runs once
    per store_id per process lifetime; subsequent requests are served from
    memory. Call `invalidate(store_id)` after a calibration save.
    """
    layout = get_raw_layout(store_id)
    transform = layout.transform
    anchor = layout.anchor

    def marker_feature(marker: Marker) -> dict:
        feature = {
            "type": "Feature",
            "id": marker.id,
            "geometry": geometry_to_geojson(marker.geometry, transform, anchor),
            "properties": {
                "category": marker.category,
                "marker_type": marker.marker_type,
                "label": marker.label,
                "icon": marker.icon,
                "min_zoom": marker.min_zoom,
            },
        }
        return feature

    departments = [
        {
            "type": "Feature",
            "id": d.id,
            "geometry": geometry_to_geojson(d.geometry, transform, anchor),
            "properties": {
                "kind": "department",
                "name": d.name,
                "category": d.category,
                "label": d.label or d.name,
                "color": d.color,
            },
        }
        for d in layout.departments
    ]

    aisles = [
        {
            "type": "Feature",
            "id": a.id,
            "geometry": geometry_to_geojson(a.geometry, transform, anchor),
            "properties": {
                "kind": "aisle",
                "name": a.name,
                "department_id": a.department_id,
                "label": a.label or a.name,
            },
        }
        for a in layout.aisles
    ]

    racks = [
        {
            "type": "Feature",
            "id": r.id,
            "geometry": geometry_to_geojson(r.geometry, transform, anchor),
            "properties": {
                "kind": "rack",
                "name": r.name,
                "aisle_id": r.aisle_id,
                "info": r.info,
            },
        }
        for r in layout.racks
    ]

    markers = [marker_feature(m) for m in layout.markers]

    return {
        "store_id": layout.store_id,
        "anchor": {"latitude": anchor.latitude, "longitude": anchor.longitude},
        "transform": transform.model_dump(),
        "departments": {"type": "FeatureCollection", "features": departments},
        "aisles": {"type": "FeatureCollection", "features": aisles},
        "racks": {"type": "FeatureCollection", "features": racks},
        "markers": {"type": "FeatureCollection", "features": markers},
    }


def invalidate(store_id: str) -> None:
    """Clear cached layout/geo data for a store (e.g. after calibration save)."""
    get_raw_layout.cache_clear()
    get_geo_layout.cache_clear()


def list_layout_ids() -> List[str]:
    if not LAYOUTS_DIR.exists():
        return []
    return [p.stem for p in LAYOUTS_DIR.glob("*.json")]


def validate_all_layouts() -> None:
    """Run on startup: validate every layout file present on disk."""
    for layout_id in list_layout_ids():
        get_raw_layout(layout_id)
