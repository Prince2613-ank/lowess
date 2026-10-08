"""
Loads and serves the store directory (data/stores.json).
"""
from __future__ import annotations

import json
import re
from functools import lru_cache
from typing import Dict, List

from backend.config import STORE_ID_PATTERN, STORES_FILE
from backend.models import Store

_STORE_ID_RE = re.compile(STORE_ID_PATTERN)


class StoreNotFoundError(Exception):
    pass


class InvalidStoreIdError(Exception):
    pass


def validate_store_id(store_id: str) -> str:
    """Reject anything that isn't a plain alphanumeric/_/- token. This is the
    only thing standing between a URL path parameter and a filesystem path,
    so it must run before store_id ever touches `open()`."""
    if not isinstance(store_id, str) or not _STORE_ID_RE.match(store_id):
        raise InvalidStoreIdError(f"Invalid store_id: {store_id!r}")
    return store_id


@lru_cache(maxsize=1)
def _load_all_stores() -> Dict[str, Store]:
    if not STORES_FILE.exists():
        raise FileNotFoundError(f"Store directory not found: {STORES_FILE}")

    with open(STORES_FILE, "r", encoding="utf-8") as f:
        raw = json.load(f)

    if not isinstance(raw, list):
        raise ValueError("stores.json must contain a JSON array")

    stores: Dict[str, Store] = {}
    for entry in raw:
        store = Store.model_validate(entry)
        if store.store_id in stores:
            raise ValueError(f"Duplicate store_id in stores.json: {store.store_id}")
        stores[store.store_id] = store
    return stores


def clear_cache() -> None:
    _load_all_stores.cache_clear()


def list_stores() -> List[Store]:
    return list(_load_all_stores().values())


def get_store(store_id: str) -> Store:
    validate_store_id(store_id)
    stores = _load_all_stores()
    store = stores.get(store_id)
    if store is None:
        raise StoreNotFoundError(f"Store not found: {store_id}")
    return store


def validate_all_stores() -> None:
    """Run on startup: force-load and validate the entire store directory."""
    _load_all_stores()


def sync_store_georeference(store_id: str, anchor: dict, transform: dict) -> None:
    """Mirror a saved layout anchor/transform into the store's `georeference`
    summary block in stores.json (informational only - the layout file
    remains the source of truth read by the rendering pipeline)."""
    validate_store_id(store_id)

    with open(STORES_FILE, "r", encoding="utf-8") as f:
        raw = json.load(f)

    for entry in raw:
        if entry.get("store_id") == store_id:
            scale = transform.get("scale", 1.0)
            entry["georeference"] = {
                "method": "affine",
                "source_crs": "local",
                "target_crs": "EPSG:4326",
                "anchor": anchor,
                "rotation_degrees": transform.get("rotation_degrees", 0.0),
                "scale_x": transform.get("scale_x") or scale,
                "scale_y": transform.get("scale_y") or scale,
                "offset_x": transform.get("offset_x", 0.0),
                "offset_y": transform.get("offset_y", 0.0),
            }
            break
    else:
        return

    # Validate the full document before writing it back.
    for entry in raw:
        Store.model_validate(entry)

    with open(STORES_FILE, "w", encoding="utf-8") as f:
        json.dump(raw, f, indent=2)

    clear_cache()
