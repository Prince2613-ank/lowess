"""
Transformation engine: floor-plan local coordinates -> real-world lat/lon.

Pipeline
--------
    floor_x, floor_y                (arbitrary local floor-plan units)
        -> floor_to_local()         scale to meters
        -> rotate + translate       rotation_degrees, offset_x/offset_y
        -> local_to_latlon()        project local ENU meters onto the globe
                                     around the store's geographic anchor
        -> latitude, longitude

We use an azimuthal equidistant (AEQD) projection centered on the anchor
point as our local tangent-plane approximation. AEQD preserves distances
and directions measured from its center point, which is exactly the
property we need: the anchor is the one geographic point we know for
certain, and everything else in the floor plan is expressed as a
displacement (in meters) from it. For an area the size of a single store
(tens to a few hundred meters across), the distortion introduced by AEQD
relative to true ground distance is negligible (sub-centimeter).

In this local system:
    local_x -> east-ish meters from the anchor
    local_y -> north-ish meters from the anchor

pyproj's AEQD "x" axis is east and "y" axis is north when lon_0/lat_0 are
set to the anchor, so local meters map directly onto (x=east, y=north).
"""
from __future__ import annotations

import math
from functools import lru_cache
from typing import List, Tuple

from pyproj import Transformer

from backend.models import Anchor, Transform


Point = Tuple[float, float]


# ---------------------------------------------------------------------------
# Projection helper (cached per anchor - building a Transformer is not free)
# ---------------------------------------------------------------------------

@lru_cache(maxsize=256)
def _get_transformer(anchor_lat: float, anchor_lon: float) -> Transformer:
    """Return a pyproj Transformer from local AEQD meters (x=east, y=north)
    centered at (anchor_lat, anchor_lon) to WGS84 lon/lat.

    always_xy=True means calls take/return (x, y) i.e. (lon, lat) order for
    the geographic side, and (east, north) order for the AEQD side.
    """
    aeqd_crs = (
        f"+proj=aeqd +lat_0={anchor_lat} +lon_0={anchor_lon} "
        "+datum=WGS84 +units=m +no_defs"
    )
    return Transformer.from_crs(aeqd_crs, "EPSG:4326", always_xy=True)


def clear_transformer_cache() -> None:
    _get_transformer.cache_clear()


# ---------------------------------------------------------------------------
# Pipeline stages
# ---------------------------------------------------------------------------

def floor_to_local(x: float, y: float, transform: Transform) -> Point:
    """Step 1-2: scale floor-plan units into meters.

    This does NOT yet apply rotation/offset - it is the raw
    "floor units -> meters" conversion using `transform.scale_x`/`scale_y`
    when set (non-uniform scale, as produced by building-footprint
    alignment), falling back to the uniform `transform.scale` otherwise.
    """
    scale_x = transform.scale_x if transform.scale_x is not None else transform.scale
    scale_y = transform.scale_y if transform.scale_y is not None else transform.scale
    return (x * scale_x, y * scale_y)


def _rotate(x: float, y: float, rotation_degrees: float) -> Point:
    """Rotate a point counter-clockwise about the origin by rotation_degrees."""
    theta = math.radians(rotation_degrees)
    cos_t, sin_t = math.cos(theta), math.sin(theta)
    return (
        x * cos_t - y * sin_t,
        x * sin_t + y * cos_t,
    )


def apply_rotation_and_offset(x: float, y: float, transform: Transform) -> Point:
    """Steps 3-4: rotate about the layout origin, then translate by the
    configured offset (in meters, east/north)."""
    rx, ry = _rotate(x, y, transform.rotation_degrees)
    return (rx + transform.offset_x, ry + transform.offset_y)


def local_to_latlon(east_m: float, north_m: float, anchor: Anchor) -> Point:
    """Step 5: convert local ENU meters (relative to the anchor) into
    (latitude, longitude) using an AEQD projection centered on the anchor.
    """
    transformer = _get_transformer(anchor.latitude, anchor.longitude)
    lon, lat = transformer.transform(east_m, north_m)
    return (lat, lon)


def latlon_to_local(lat: float, lon: float, anchor: Anchor) -> Point:
    """Inverse of local_to_latlon: (latitude, longitude) -> local ENU meters
    relative to the anchor."""
    transformer = _get_transformer(anchor.latitude, anchor.longitude)
    east, north = transformer.transform(lon, lat, direction="INVERSE")
    return (east, north)


def latlon_to_floor(lat: float, lon: float, transform: Transform, anchor: Anchor) -> Point:
    """Full inverse pipeline: (latitude, longitude) -> floor-plan (x, y).

    Inverts, in order: local_to_latlon, then rotation+offset, then scale.
    """
    east, north = latlon_to_local(lat, lon, anchor)

    ox, oy = east - transform.offset_x, north - transform.offset_y
    theta = -math.radians(transform.rotation_degrees)
    cos_t, sin_t = math.cos(theta), math.sin(theta)
    mx = ox * cos_t - oy * sin_t
    my = ox * sin_t + oy * cos_t

    scale_x = transform.scale_x if transform.scale_x is not None else transform.scale
    scale_y = transform.scale_y if transform.scale_y is not None else transform.scale
    return (mx / scale_x, my / scale_y)


def floor_to_latlon(
    x: float, y: float, transform: Transform, anchor: Anchor
) -> Point:
    """Full pipeline: floor-plan (x, y) -> (latitude, longitude)."""
    mx, my = floor_to_local(x, y, transform)
    ex, ny = apply_rotation_and_offset(mx, my, transform)
    return local_to_latlon(ex, ny, anchor)


# ---------------------------------------------------------------------------
# Geometry-level conversion (floor-plan coordinate arrays -> [lon, lat] arrays)
# ---------------------------------------------------------------------------
# GeoJSON coordinate order is [longitude, latitude], which is why these
# helpers return [lon, lat] pairs rather than the (lat, lon) tuples above.

def _point_to_geo(coord: List[float], transform: Transform, anchor: Anchor) -> List[float]:
    lat, lon = floor_to_latlon(coord[0], coord[1], transform, anchor)
    return [lon, lat]


def _line_to_geo(coords: List[List[float]], transform: Transform, anchor: Anchor) -> List[List[float]]:
    return [_point_to_geo(c, transform, anchor) for c in coords]


def _multiline_or_polygon_to_geo(
    coords: List[List[List[float]]], transform: Transform, anchor: Anchor
) -> List[List[List[float]]]:
    return [_line_to_geo(ring, transform, anchor) for ring in coords]


def _multipolygon_to_geo(
    coords: List[List[List[List[float]]]], transform: Transform, anchor: Anchor
) -> List[List[List[List[float]]]]:
    return [_multiline_or_polygon_to_geo(poly, transform, anchor) for poly in coords]


def geometry_to_geojson(geometry, transform: Transform, anchor: Anchor) -> dict:
    """Convert a floor-plan `Geometry` (local x/y units) into a standard
    GeoJSON geometry dict with real-world [lon, lat] coordinates.

    Supports Point, LineString, MultiLineString, Polygon, MultiPolygon.
    """
    gtype = geometry.type
    coords = geometry.coordinates

    if gtype == "Point":
        geo_coords = _point_to_geo(coords, transform, anchor)
    elif gtype == "LineString":
        geo_coords = _line_to_geo(coords, transform, anchor)
    elif gtype in ("MultiLineString", "Polygon"):
        geo_coords = _multiline_or_polygon_to_geo(coords, transform, anchor)
    elif gtype == "MultiPolygon":
        geo_coords = _multipolygon_to_geo(coords, transform, anchor)
    else:
        raise ValueError(f"Unsupported geometry type: {gtype!r}")

    return {"type": gtype, "coordinates": geo_coords}
