"""Tests for backend/georeference.py: building alignment engine."""
import pytest

from backend import georeference as geo
from backend.layout_service import get_raw_layout
from backend.models import Anchor, ControlPoint, FloorPoint, GeoPoint, Transform


@pytest.fixture
def layout():
    return get_raw_layout("1665")


@pytest.fixture
def building():
    return geo.load_building("1665")


def test_four_point_affine_transformation():
    """A synthetic 4-point similarity (known scale/rotation/translation)
    is recovered by the least-squares control-point fit."""
    anchor = Anchor(latitude=41.8140843218019, longitude=-72.71526758866406)
    true_transform = Transform(scale=1.0, scale_x=0.5, scale_y=0.5, rotation_degrees=30.0,
                                offset_x=20.0, offset_y=-10.0)

    from backend.transform import floor_to_latlon

    floor_pts = [(0, 0), (100, 0), (100, 60), (0, 60)]
    control_points = []
    for i, (x, y) in enumerate(floor_pts):
        lat, lon = floor_to_latlon(x, y, true_transform, anchor)
        control_points.append(
            ControlPoint(name=f"p{i}", floor=FloorPoint(x=x, y=y), geo=GeoPoint(latitude=lat, longitude=lon))
        )

    fit = geo.fit_similarity_from_control_points(control_points, anchor)
    assert fit["scale_x"] == pytest.approx(0.5, abs=1e-6)
    assert fit["scale_y"] == pytest.approx(0.5, abs=1e-6)
    assert fit["rotation_degrees"] == pytest.approx(30.0, abs=1e-4)
    assert fit["rms_error_m"] < 1e-6


def test_fit_requires_at_least_two_points():
    anchor = Anchor(latitude=41.8140843218019, longitude=-72.71526758866406)
    with pytest.raises(ValueError):
        geo.fit_similarity_from_control_points(
            [ControlPoint(name="only-one", floor=FloorPoint(x=0, y=0), geo=GeoPoint(latitude=41.8, longitude=-72.7))],
            anchor,
        )


def test_building_floor_bounding_box_comparison(layout, building):
    building_bounds = geo.calculate_building_bounds(building, layout.anchor)
    floor_bounds = geo.calculate_floor_bounds(layout)

    # The real Lowe's #1665 building is on the order of ~100-200m across;
    # the simplified floor plan is on the order of ~100-150m - same order
    # of magnitude, sanity-checking that both bounding boxes were computed
    # from real data and not degenerate.
    assert 50 < building_bounds["width_m"] < 500
    assert 50 < building_bounds["height_m"] < 500
    assert floor_bounds["width_m"] > 0
    assert floor_bounds["height_m"] > 0


def test_initial_and_optimized_transform_improve_iou(layout, building):
    initial = geo.calculate_initial_transform(building, layout)
    optimized = geo.optimize_transform(initial, building, layout)

    assert 0.0 <= initial["iou"] <= 1.0
    assert 0.0 <= optimized["iou"] <= 1.0
    # Coordinate-descent refinement should never make the fit worse.
    assert optimized["iou"] >= initial["iou"] - 1e-9


def test_alignment_error_is_reasonable_for_saved_calibration(layout, building):
    """The calibration currently saved for store 1665 (from auto-align) should
    report a small, finite alignment error - not a huge or NaN blowup, which
    is exactly the class of bug the scale_x/scale_y unit mismatch caused
    during development."""
    report = geo.calculate_alignment_error(building, layout)
    assert report["alignment_error_m"] is not None
    assert report["alignment_error_m"] < 50.0  # meters - loose upper bound
    assert 0.0 <= report["iou"] <= 1.0


def test_alignment_error_for_grossly_wrong_transform_is_large(layout, building):
    bad_transform = Transform(scale=1.0, scale_x=0.001, scale_y=0.001, rotation_degrees=0.0,
                               offset_x=10000.0, offset_y=10000.0)
    report = geo.calculate_alignment_error(building, layout, bad_transform)
    assert report["alignment_error_m"] > 1000.0
    assert report["iou"] == pytest.approx(0.0, abs=1e-6)


def test_building_not_found_raises():
    with pytest.raises(geo.BuildingNotFoundError):
        geo.load_building("9999999")


def test_building_path_traversal_rejected():
    from backend.store_service import InvalidStoreIdError

    with pytest.raises(InvalidStoreIdError):
        geo.load_building("../../etc/passwd")
