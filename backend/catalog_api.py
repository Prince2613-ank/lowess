"""Nationwide read API, independent of legacy local-coordinate calibration."""
import json
import os
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from backend.config import BASE_DIR
from backend.store_service import validate_store_id, InvalidStoreIdError

router = APIRouter()


def root():
    return Path(os.getenv("LOWES_OUTPUT", str(BASE_DIR))).resolve()


def index():
    restored = []
    stores_root = root() / "stores"
    if stores_root.exists():
        for store_file in sorted(stores_root.glob("*/store.json")):
            store = json.loads(store_file.read_text(encoding="utf-8"))
            store_dir = store_file.parent
            has_map = all((store_dir / name).is_file() for name in ("aisle.geojson", "department.geojson", "rack.geojson"))
            restored.append({
                **store,
                "state": "Connecticut" if store.get("state_code") == "CT" and store.get("state") == "CT" else store.get("state", ""),
                "state_code": store.get("state_code") or store.get("state"),
                "map_file": f"stores/{store['store_id']}/raw_map.json" if (store_dir / "raw_map.json").is_file() else None,
                "indoor_map_status": "success" if has_map else "no_indoor_map",
            })
    if restored:
        return {"stores": restored}

    path = root() / "stores-index.json"
    if not path.exists():
        return {"stores": [], "message": "Run python scripts/run_pipeline.py to build the catalog"}
    return json.loads(path.read_text(encoding="utf-8"))


def _store_dir(store_id: str) -> Path:
    try:
        validate_store_id(store_id)
    except InvalidStoreIdError:
        raise HTTPException(400, "Invalid store ID")
    path = (root() / "stores" / store_id).resolve()
    stores_root = (root() / "stores").resolve()
    if stores_root != path.parent:
        raise HTTPException(400, "Invalid store ID")
    return path


def _read_json(path: Path, fallback: Any) -> Any:
    if not path.exists():
        return fallback
    return json.loads(path.read_text(encoding="utf-8"))


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding="utf-8")
    temporary.replace(path)


@router.get("/stores")
def stores():
    return index()


@router.get("/stores/{store_id}/map")
def store_map(store_id: str):
    store_dir = _store_dir(store_id)
    entry = next((e for e in index()["stores"] if e["store_id"] == store_id), None)
    if entry is None:
        raise HTTPException(404, "Store not found")
    layer_files = {
        "Lowes_aisle": store_dir / "aisle.geojson",
        "Lowes_depertment": store_dir / "department.geojson",
        "Lowes_rack": store_dir / "rack.geojson",
    }
    if all(path.is_file() for path in layer_files.values()):
        return {key: json.loads(path.read_text(encoding="utf-8")) for key, path in layer_files.items()}
    raw_map = store_dir / "raw_map.json"
    if raw_map.is_file():
        return json.loads(raw_map.read_text(encoding="utf-8"))
    if not entry.get("map_file"):
        raise HTTPException(404, "Store map unavailable")
    path = (root() / entry["map_file"]).resolve()
    if root() not in path.parents or not path.is_file():
        raise HTTPException(404, "Store map unavailable")
    return FileResponse(path, media_type="application/geo+json")


@router.post("/stores/{store_id}/map")
def save_store_map(store_id: str, body: dict[str, Any]):
    store_dir = _store_dir(store_id)
    if next((e for e in index()["stores"] if e["store_id"] == store_id), None) is None and not (store_dir / "store.json").is_file():
        raise HTTPException(404, "Store not found")
    _write_json(store_dir / "raw_map.json", body)
    status = _read_json(store_dir / "map_status.json", {})
    if not isinstance(status, dict):
        status = {}
    status.update({"status": "saved", "map_file": f"stores/{store_id}/raw_map.json"})
    _write_json(store_dir / "map_status.json", status)
    return {"status": "ok", "store_id": store_id, "map_file": f"stores/{store_id}/raw_map.json"}


@router.get("/stores/{store_id}/details")
def store_details(store_id: str):
    store_dir = _store_dir(store_id)
    details = _read_json(store_dir / "store.json", None)
    if details is None:
        entry = next((e for e in index()["stores"] if e["store_id"] == store_id), None)
        if entry is None:
            raise HTTPException(404, "Store not found")
        return entry
    return details


@router.post("/stores/{store_id}/details")
def save_store_details(store_id: str, body: dict[str, Any]):
    store_dir = _store_dir(store_id)
    if str(body.get("store_id", store_id)) != store_id:
        raise HTTPException(422, "store_id does not match URL")
    current = _read_json(store_dir / "store.json", {})
    if not isinstance(current, dict):
        current = {}
    merged = {**current, **body, "store_id": store_id}
    _write_json(store_dir / "store.json", merged)
    return merged


@router.get("/report")
def report():
    path = root() / "pipeline-report.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"message": "Pipeline has not run"}
