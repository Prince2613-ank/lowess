"""End-to-end API tests via FastAPI's TestClient (in-process, no network)."""
import json

import pytest
from fastapi.testclient import TestClient

from backend.config import GEOREFERENCE_DIR, LAYOUTS_DIR, STORES_DIR, STORES_FILE
from backend.main import app

client = TestClient(app)


def test_list_stores():
    resp = client.get("/api/stores")
    assert resp.status_code == 200
    stores = resp.json()
    assert any(s["store_id"] == "1665" for s in stores)


def test_get_store():
    resp = client.get("/api/stores/1665")
    assert resp.status_code == 200
    assert resp.json()["store_id"] == "1665"


def test_get_store_not_found():
    resp = client.get("/api/stores/nope")
    assert resp.status_code == 404


def test_store_id_path_traversal_rejected():
    resp = client.get("/api/stores/..%2F..%2Fetc%2Fpasswd")
    assert resp.status_code in (400, 404)


def test_get_layout_raw_and_geo():
    raw = client.get("/api/stores/1665/layout/raw")
    assert raw.status_code == 200
    assert raw.json()["store_id"] == "1665"

    geo = client.get("/api/stores/1665/layout")
    assert geo.status_code == 200
    assert geo.json()["departments"]["type"] == "FeatureCollection"


def test_get_map_combines_store_anchor_layout():
    resp = client.get("/api/stores/1665/map")
    assert resp.status_code == 200
    body = resp.json()
    assert "store" in body and "anchor" in body and "layout" in body
    assert len(body["layout"]["departments"]["features"]) > 0


def test_get_building():
    resp = client.get("/api/stores/1665/building")
    assert resp.status_code == 200
    body = resp.json()
    assert body["type"] == "FeatureCollection"
    assert body["metadata"]["source"] == "OpenStreetMap"


def test_get_georeference_returns_control_points():
    resp = client.get("/api/stores/1665/georeference")
    assert resp.status_code == 200
    body = resp.json()
    assert body["store_id"] == "1665"
    assert len(body["control_points"]) >= 1


def test_debug_georeference_corners_round_trip():
    georef_path = STORES_DIR / "1665" / "georeference.json"
    original = georef_path.read_text(encoding="utf-8") if georef_path.exists() else None
    try:
        payload = {
            "store_id": "1665",
            "offset_x": 27.0,
            "offset_y": -40.0,
            "scale": 0.84,
            "rotation": 180.0,
            "corners": {
                "nw": {"x": 10.23, "y": -0.53},
                "ne": {"x": -49.45, "y": 1.48},
                "sw": {"x": 10.67, "y": 3.12},
                "se": {"x": -48.99, "y": 6.35},
            },
        }

        resp = client.post("/api/store/1665/debug-georeference", json=payload)
        assert resp.status_code == 200
        body = resp.json()
        assert body["corners"]["nw"]["x"] == pytest.approx(10.23)

        saved = json.loads(georef_path.read_text(encoding="utf-8"))
        assert saved["corners"]["nw"]["x"] == pytest.approx(10.23)
        assert saved["corners"]["se"]["y"] == pytest.approx(6.35)
        assert "debug" not in saved

        loaded = client.get("/api/store/1665/debug-georeference")
        assert loaded.status_code == 200
        assert loaded.headers['cache-control'] == 'no-store'
        assert TestClient(app).get('/api/store/1665/debug-georeference').json() == body
        assert loaded.json()["corners"]["nw"]["y"] == pytest.approx(-0.53)
        assert loaded.json()["corners"]["se"]["x"] == pytest.approx(-48.99)
    finally:
        if original is None:
            georef_path.unlink(missing_ok=True)
        else:
            georef_path.write_text(original, encoding="utf-8")


def test_auto_align_endpoint():
    resp = client.post("/api/stores/1665/auto-align")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert "transform" in body
    assert body["alignment_error_m"] < 50.0


def test_alignment_report_endpoint():
    resp = client.get("/api/stores/1665/alignment-report")
    assert resp.status_code == 200
    body = resp.json()
    assert body["store_id"] == "1665"
    assert body["alignment_error_m"] is not None


def test_building_needs_calibration_when_footprint_missing(monkeypatch):
    """A store with no building footprint on file gets an explicit
    needs_calibration status, never a fabricated result."""
    from backend import georeference

    def raise_not_found(store_id):
        raise georeference.BuildingNotFoundError()

    monkeypatch.setattr(georeference, "load_building", raise_not_found)
    resp = client.get("/api/stores/1665/building")
    assert resp.status_code == 200
    assert resp.json()["status"] == "needs_calibration"


class _CalibrationRoundTrip:
    """Save calibration, verify persisted values, then restore the original
    file so the test suite doesn't mutate fixture data."""

    def __enter__(self):
        self.layout_path = LAYOUTS_DIR / "1665.json"
        self.stores_path = STORES_FILE
        self.original_layout = self.layout_path.read_text(encoding="utf-8")
        self.original_stores = self.stores_path.read_text(encoding="utf-8")
        return self

    def __exit__(self, *exc):
        self.layout_path.write_text(self.original_layout, encoding="utf-8")
        self.stores_path.write_text(self.original_stores, encoding="utf-8")
        from backend import layout_service, store_service

        layout_service.invalidate("1665")
        store_service.clear_cache()


def test_calibration_save_and_load_round_trip():
    with _CalibrationRoundTrip():
        payload = {
            "anchor_latitude": 41.8140843218019,
            "anchor_longitude": -72.71526758866406,
            "scale": 0.3048,
            "scale_x": 0.4,
            "scale_y": 0.35,
            "rotation_degrees": 12.0,
            "offset_x": 5.0,
            "offset_y": -2.0,
        }
        resp = client.post("/api/stores/1665/calibrate", json=payload)
        assert resp.status_code == 200
        assert resp.json()["transform"]["scale_x"] == pytest.approx(0.4)

        raw = client.get("/api/stores/1665/layout/raw")
        assert raw.json()["transform"]["scale_x"] == pytest.approx(0.4)
        assert raw.json()["transform"]["rotation_degrees"] == pytest.approx(12.0)

        store = client.get("/api/stores/1665")
        assert store.json()["georeference"]["scale_x"] == pytest.approx(0.4)


def test_calibration_rejects_invalid_scale():
    payload = {
        "anchor_latitude": 41.8140843218019,
        "anchor_longitude": -72.71526758866406,
        "scale": -1.0,
        "rotation_degrees": 0.0,
        "offset_x": 0.0,
        "offset_y": 0.0,
    }
    resp = client.post("/api/stores/1665/calibrate", json=payload)
    assert resp.status_code == 422


def test_georeference_save_and_load_round_trip():
    georef_path = GEOREFERENCE_DIR / "1665.json"
    original = georef_path.read_text(encoding="utf-8")
    try:
        payload = {
            "store_id": "1665",
            "source": "manual",
            "control_points": [
                {"name": "a", "floor": {"x": 0, "y": 0}, "geo": {"latitude": 41.8145, "longitude": -72.7142}},
                {"name": "b", "floor": {"x": 400, "y": 0}, "geo": {"latitude": 41.8145, "longitude": -72.7160}},
            ],
        }
        resp = client.post("/api/stores/1665/georeference", json=payload)
        assert resp.status_code == 200
        body = resp.json()
        assert "fitted_transform" in body

        loaded = client.get("/api/stores/1665/georeference")
        assert len(loaded.json()["control_points"]) == 2
    finally:
        georef_path.write_text(original, encoding="utf-8")


def test_georeference_store_id_mismatch_rejected():
    payload = {"store_id": "wrong-id", "source": "manual", "control_points": []}
    resp = client.post("/api/stores/1665/georeference", json=payload)
    assert resp.status_code == 422


def test_invalid_store_id_rejected_on_calibrate():
    # Starlette normalizes "../.." path segments during routing itself, so
    # this either 404s/405s at the router or 400s in our own store_id
    # validation - either way, it must never reach the filesystem.
    resp = client.post(
        "/api/stores/..%2F..%2Fpasswd/calibrate",
        json={
            "anchor_latitude": 0, "anchor_longitude": 0, "scale": 1.0,
            "rotation_degrees": 0, "offset_x": 0, "offset_y": 0,
        },
    )
    assert resp.status_code in (400, 404, 405)

    # A store_id that stays within one path segment but fails our own
    # allow-list pattern must be rejected by our validation (400).
    resp2 = client.post(
        "/api/stores/not$valid/calibrate",
        json={
            "anchor_latitude": 0, "anchor_longitude": 0, "scale": 1.0,
            "rotation_degrees": 0, "offset_x": 0, "offset_y": 0,
        },
    )
    assert resp2.status_code == 400
