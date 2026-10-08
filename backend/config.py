"""
Central configuration for the Lowe's Map System backend.

Keeping all filesystem paths in one place makes it easy to reason about
what the API is allowed to touch, which matters because layout files are
looked up by a user-supplied store_id.
"""
from __future__ import annotations

from pathlib import Path

# backend/ -> project root
BASE_DIR: Path = Path(__file__).resolve().parent.parent

DATA_DIR: Path = BASE_DIR / "data"
STORES_DIR: Path = BASE_DIR / "stores"
LAYOUTS_DIR: Path = DATA_DIR / "layouts"
STORES_FILE: Path = DATA_DIR / "stores.json"
BUILDINGS_DIR: Path = DATA_DIR / "buildings"
GEOREFERENCE_DIR: Path = DATA_DIR / "georeference"
LAYOUT_IMAGES_DIR: Path = DATA_DIR / "layout-images"
GEOJSON_DIR: Path = BASE_DIR

FRONTEND_DIR: Path = BASE_DIR / "frontend"

# Only store_ids matching this pattern are ever used to build a filesystem
# path. This blocks path traversal ("../../etc/passwd") and null-byte tricks.
STORE_ID_PATTERN = r"^[A-Za-z0-9_-]{1,32}$"

# CORS - loosened for local dev of the static frontend; tighten for prod.
ALLOWED_ORIGINS = ["*"]
