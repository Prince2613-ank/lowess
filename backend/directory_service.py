"""Cached Lowe's directory discovery and compatibility access for the UI."""
from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen

from bs4 import BeautifulSoup

from backend.config import DATA_DIR, LAYOUTS_DIR, STORES_DIR, STORES_FILE

logger = logging.getLogger("lowes_directory")
BASE_URL = "https://www.lowes.com"
DIRECTORY_URL = f"{BASE_URL}/Lowes-Stores"
_STATE_RE = re.compile(r"^/Lowes-Stores/([^/]+)/([A-Za-z]{2})/?$", re.I)
_STORE_RE = re.compile(r"^/store/([A-Za-z]{2})-([^/]+)/([0-9]+)/?$", re.I)


def _read(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def _write(path: Path, value: Any) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding="utf-8")
    temporary.replace(path)


def _links(html: str, base: str):
    soup = BeautifulSoup(html, "html.parser")
    seen = set()
    for anchor in soup.select("a[href]"):
        url = urljoin(base, anchor["href"]).split("#")[0].split("?")[0]
        if urlparse(url).netloc != urlparse(base).netloc or url in seen:
            continue
        seen.add(url)
        yield anchor.get_text(" ", strip=True), url


def parse_states(html: str) -> list[dict[str, str]]:
    result = []
    for text, url in _links(html, DIRECTORY_URL):
        match = _STATE_RE.match(urlparse(url).path)
        if match:
            result.append({"state_name": text or match[1].replace("-", " "), "state_code": match[2].upper(), "url": url})
    return sorted(result, key=lambda item: item["state_name"].casefold())


def parse_state(html: str, state_code: str, state_name: str) -> tuple[list[str], list[dict[str, str]]]:
    stores = []
    cities = []
    for text, url in _links(html, DIRECTORY_URL):
        path = urlparse(url).path
        match = _STORE_RE.match(path)
        if match and match[1].upper() == state_code.upper():
            city = match[2].replace("-", " ")
            stores.append({"state": state_name, "state_code": state_code.upper(), "city": city,
                           "store_id": match[3], "store_url": url})
            cities.append(city)
        elif path.lower().startswith(urlparse(DIRECTORY_URL).path.lower() + "/"):
            city = text or path.rstrip("/").split("/")[-1].replace("-", " ")
            if city and city.casefold() not in {item.casefold() for item in cities}:
                cities.append(city)
    stores = list({item["store_id"]: item for item in stores}.values())
    return sorted(set(cities), key=str.casefold), stores


def _request(url: str) -> str:
    request = Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36"})
    with urlopen(request, timeout=30) as response:
        return response.read().decode("utf-8", errors="replace")


def _legacy_fallback() -> tuple[list[dict[str, str]], list[dict[str, Any]]]:
    """Expose the bundled calibrated store when the official site is blocked."""
    raw = _read(STORES_FILE, [])
    stores = []
    for item in raw:
        if item.get("store_id") != "1665":
            continue
        stores.append({
            **item,
            "state": "Connecticut",
            "state_code": "CT",
            "city": "Bloomfield",
            "zip": "06002",
            "store_url": f"{BASE_URL}/store/CT-Bloomfield/{item['store_id']}",
            "indoor_map_url": f"{BASE_URL}/omniselling/store/{item['store_id']}/map-view",
            "map_file": "legacy-layout",
            "map_status": "imported",
        })
    return ([{"state_name": "Connecticut", "state_code": "CT", "url": f"{DIRECTORY_URL}/Connecticut/CT"}], stores)


def load_states() -> list[dict[str, str]]:
    cached = _read(DATA_DIR / "states.json", [])
    if isinstance(cached, dict):
        cached = cached.get("states", [])
    if cached:
        return sorted(cached, key=lambda item: item.get("state_name", item.get("name", "")).casefold())
    return _legacy_fallback()[0]


def load_directory_stores() -> list[dict[str, Any]]:
    restored = []
    stores_root = STORES_DIR
    if stores_root.exists():
        for store_file in sorted(stores_root.glob("*/store.json")):
            store = _read(store_file, {})
            if not isinstance(store, dict) or not store.get("store_id"):
                continue
            store_dir = store_file.parent
            status = _read(store_dir / "map_status.json", {})
            has_geojson_map = all((store_dir / name).is_file() for name in ("aisle.geojson", "department.geojson", "rack.geojson"))
            has_layout = (LAYOUTS_DIR / f"{store['store_id']}.json").is_file()
            restored.append({
                **store,
                "state": "Connecticut" if store.get("state_code") == "CT" and store.get("state") == "CT" else store.get("state", ""),
                "state_code": store.get("state_code") or store.get("state"),
                "indoor_map_url": store.get("map_url") or f"{BASE_URL}/omniselling/store/{store['store_id']}/map-view",
                "map_file": f"stores/{store['store_id']}/raw_map.json" if (store_dir / "raw_map.json").is_file() else None,
                "map_status": status.get("status", "available" if has_layout or has_geojson_map else "unavailable"),
                "indoor_map_status": "success" if has_layout or has_geojson_map else "no_indoor_map",
            })
    if restored:
        return restored

    connecticut = _read(DATA_DIR / "connecticut" / "stores.json", [])
    if connecticut:
        legacy = _legacy_fallback()[1]
        by_id = {item.get("store_id"): item for item in connecticut}
        for item in legacy:
            by_id[item["store_id"]] = {**by_id.get(item["store_id"], {}), **item}
        return list(by_id.values())
    cached = _read(DATA_DIR / "directory-stores.json", [])
    if cached:
        return cached
    return _legacy_fallback()[1]


def listed_stores() -> list[dict[str, Any]]:
    """Stores shown in the directory: those whose indoor map is known to be missing are left out."""
    return [item for item in load_directory_stores() if item.get("indoor_map_status") != "no_indoor_map"]


def cities_for(state_code: str) -> list[str]:
    normalized = state_code.upper()
    restored = sorted({item.get("city") for item in listed_stores() if item.get("state_code", "").upper() == normalized and item.get("city")}, key=str.casefold)
    if restored:
        return restored
    if normalized == "CT":
        cached = _read(DATA_DIR / "connecticut" / "cities.json", [])
        if cached:
            return sorted({item["city"] for item in cached if item.get("city")}, key=str.casefold)
    cached = _read(DATA_DIR / "cities.json", [])
    if isinstance(cached, dict):
        cached = cached.get("cities", [])
    cities = [item.get("name") for item in cached if item.get("state", "").upper() == normalized]
    if cities:
        return sorted(set(cities), key=str.casefold)
    return sorted({item.get("city") for item in listed_stores() if item.get("state_code", "").upper() == normalized and item.get("city")}, key=str.casefold)


def stores_for(state_code: Optional[str] = None, city: Optional[str] = None) -> list[dict[str, Any]]:
    stores = listed_stores()
    if state_code:
        stores = [item for item in stores if item.get("state_code", "").upper() == state_code.upper()]
    if city:
        stores = [item for item in stores if item.get("city", "").casefold() == city.casefold()]
    return sorted(stores, key=lambda item: (item.get("state", ""), item.get("city", ""), item.get("store_id", "")))


def store(store_id: str) -> dict[str, Any] | None:
    return next((item for item in load_directory_stores() if item.get("store_id") == store_id), None)


def refresh() -> dict[str, Any]:
    """Fetch and cache the directory; retain existing cache on access failure."""
    logger.info("[DIRECTORY] Loading Lowe's state directory")
    try:
        states = parse_states(_request(DIRECTORY_URL))
        if not states:
            raise RuntimeError("No state links discovered")
        _write(DATA_DIR / "states.json", {"states": states})
        logger.info("[DIRECTORY] Found %d states", len(states))
        all_cities, all_stores = [], []
        for state in states:
            logger.info("[STATE] Loading %s", state["state_name"])
            logger.info("[STATE] URL: %s", state["url"])
            cities, stores = parse_state(_request(state["url"]), state["state_code"], state["state_name"])
            logger.info("[STATE] Found %d cities and %d stores", len(cities), len(stores))
            all_cities.extend({"name": city, "state": state["state_code"]} for city in cities)
            all_stores.extend(stores)
        _write(DATA_DIR / "cities.json", {"cities": all_cities})
        _write(DATA_DIR / "directory-stores.json", all_stores)
        return {"status": "refreshed", "states": len(states), "stores": len(all_stores)}
    except (HTTPError, URLError, TimeoutError, RuntimeError, ValueError) as exc:
        logger.warning("Using cached Lowe's store directory: %s", exc)
        return {"status": "cached", "message": "Using cached Lowe's store directory.", "error": str(exc), "states": len(load_states()), "stores": len(load_directory_stores())}
