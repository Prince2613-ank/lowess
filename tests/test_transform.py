"""Tests for backend/transform.py: floor <-> geographic conversion."""
import math

import pytest

from backend.models import Anchor, Transform
from backend.transform import (
    apply_rotation_and_offset,
    floor_to_latlon,
    floor_to_local,
    latlon_to_floor,
    latlon_to_local,
)

ANCHOR = Anchor(latitude=41.8140843218019, longitude=-72.71526758866406)


def test_floor_to_geographic_transformation_basic():
    """A point at the transform origin lands exactly on the anchor."""
    t = Transform(scale=0.3048)
    lat, lon = floor_to_latlon(0, 0, t, ANCHOR)
    assert lat == pytest.approx(ANCHOR.latitude)
    assert lon == pytest.approx(ANCHOR.longitude)


def test_inverse_geographic_to_floor_transformation():
    t = Transform(scale=0.3048, scale_x=0.38, scale_y=0.36, rotation_degrees=25, offset_x=10, offset_y=-5)
    for x, y in [(0, 0), (123.4, 56.7), (-40, 200)]:
        lat, lon = floor_to_latlon(x, y, t, ANCHOR)
        rx, ry = latlon_to_floor(lat, lon, t, ANCHOR)
        assert rx == pytest.approx(x, abs=1e-6)
        assert ry == pytest.approx(y, abs=1e-6)


def test_rotation_only():
    """A 90-degree rotation swaps east/north displacement sign as expected."""
    t = Transform(scale=1.0, rotation_degrees=90.0)
    east, north = apply_rotation_and_offset(1.0, 0.0, t)
    assert east == pytest.approx(0.0, abs=1e-9)
    assert north == pytest.approx(1.0, abs=1e-9)


def test_scale_only():
    t = Transform(scale=2.5)
    mx, my = floor_to_local(10, 4, t)
    assert mx == pytest.approx(25.0)
    assert my == pytest.approx(10.0)


def test_scale_x_y_override_scale():
    """scale_x/scale_y override the uniform `scale`, per-axis."""
    t = Transform(scale=1.0, scale_x=2.0, scale_y=3.0)
    mx, my = floor_to_local(10, 10, t)
    assert mx == pytest.approx(20.0)
    assert my == pytest.approx(30.0)


def test_translation_only():
    t = Transform(scale=1.0, offset_x=5.0, offset_y=-3.0)
    east, north = apply_rotation_and_offset(0.0, 0.0, t)
    assert east == pytest.approx(5.0)
    assert north == pytest.approx(-3.0)


def test_known_distance_preserved():
    """A 100-unit displacement at scale 1.0 comes back as ~100m geodesic
    distance from the anchor (AEQD preserves distance from its center)."""
    t = Transform(scale=1.0)
    lat, lon = floor_to_latlon(100.0, 0.0, t, ANCHOR)

    e, n = latlon_to_local(lat, lon, ANCHOR)
    dist = math.hypot(e, n)
    assert dist == pytest.approx(100.0, abs=1e-6)
