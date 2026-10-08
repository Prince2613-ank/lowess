"""Tests for backend/models.py validation: invalid GeoJSON, store shape,
NaN/Inf rejection, control points."""
import math

import pytest
from pydantic import ValidationError

from backend.models import (
    BuildingFeatureCollection,
    ControlPoint,
    FloorPoint,
    GeoPoint,
    GeoreferenceFile,
    Geometry,
    Store,
    Transform,
)


def test_invalid_geojson_nan_coordinate_rejected():
    with pytest.raises(ValidationError):
        Geometry(type="Point", coordinates=[float("nan"), 1.0])


def test_invalid_geojson_inf_coordinate_rejected():
    with pytest.raises(ValidationError):
        Geometry(type="Point", coordinates=[float("inf"), 1.0])


def test_invalid_geojson_wrong_nesting_depth_rejected():
    # A Polygon needs a ring-of-points (depth 2); this is only depth 1.
    with pytest.raises(ValidationError):
        Geometry(type="Polygon", coordinates=[[0, 0], [1, 0], [1, 1]])


def test_building_geojson_out_of_range_longitude_rejected():
    bad = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {},
                "geometry": {"type": "Polygon", "coordinates": [[[200.0, 41.8], [200.1, 41.8], [200.1, 41.9], [200.0, 41.8]]]},
            }
        ],
    }
    with pytest.raises(ValidationError):
        BuildingFeatureCollection.model_validate(bad)


def test_building_geojson_nan_rejected():
    bad = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {},
                "geometry": {"type": "Polygon", "coordinates": [[[float("nan"), 41.8], [-72.1, 41.8], [-72.1, 41.9], [float("nan"), 41.8]]]},
            }
        ],
    }
    with pytest.raises(ValidationError):
        BuildingFeatureCollection.model_validate(bad)


def test_building_geojson_valid_polygon_accepted():
    good = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"store_id": "1665", "type": "store_building"},
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[[-72.716, 41.813], [-72.714, 41.813], [-72.714, 41.815], [-72.716, 41.815], [-72.716, 41.813]]],
                },
            }
        ],
    }
    parsed = BuildingFeatureCollection.model_validate(good)
    assert len(parsed.features) == 1


def test_store_requires_valid_lat_lon():
    with pytest.raises(ValidationError):
        Store(store_id="1", name="x", address="y", latitude=999.0, longitude=0.0, layout_id="1")


def test_store_id_must_be_non_empty():
    with pytest.raises(ValidationError):
        Store(store_id="", name="x", address="y", latitude=1.0, longitude=1.0, layout_id="1")


def test_store_building_id_optional():
    s = Store(store_id="1", name="x", address="y", latitude=1.0, longitude=1.0, layout_id="1")
    assert s.building_id is None


def test_transform_scale_must_be_positive():
    with pytest.raises(ValidationError):
        Transform(scale=-1.0)


def test_transform_scale_x_must_be_positive_when_set():
    with pytest.raises(ValidationError):
        Transform(scale=1.0, scale_x=-0.5)


def test_transform_rejects_nan_rotation():
    with pytest.raises(ValidationError):
        Transform(scale=1.0, rotation_degrees=float("nan"))


def test_control_point_rejects_nan_floor_coords():
    with pytest.raises(ValidationError):
        ControlPoint(
            name="bad",
            floor=FloorPoint(x=float("nan"), y=0),
            geo=GeoPoint(latitude=41.8, longitude=-72.7),
        )


def test_control_point_rejects_invalid_lat():
    with pytest.raises(ValidationError):
        ControlPoint(
            name="bad",
            floor=FloorPoint(x=0, y=0),
            geo=GeoPoint(latitude=999.0, longitude=-72.7),
        )


def test_georeference_file_accepts_empty_control_points():
    g = GeoreferenceFile(store_id="1665", source="manual", control_points=[])
    assert g.control_points == []
