"""
Georeferencing engine: aligns a store's floor plan against its real-world
building footprint.

This module is the "auto align" half of the calibration workflow. It never
invents accuracy - every number it produces is derived from the actual
building footprint (data/buildings/{store_id}.geojson) and the actual floor
layout (data/layouts/{store_id}.json). If a building footprint is not on
disk, callers get back an explicit `needs_calibration` result instead of a
guess.

Pipeline
--------
    building footprint (WGS84 polygon)
        -> project to local AEQD meters around the store anchor
        -> minimum rotated bounding rectangle (shapely)
    floor plan (local x/y units)
        -> bounding box, converted to meters via transform.scale
    calculate_initial_transform()
        -> coarse similarity transform matching the floor-plan bounding box
           to the building's minimum rotated rectangle (tries the two axis
           correspondences - long-to-long and long-to-short - and a scale
           sweep, scored by IoU)
    optimize_transform()
        -> coordinate-descent refinement of (rotation, scale_x, scale_y,
           offset_x, offset_y) that maximizes IoU between the transformed
           floor-plan bounding box and the real building polygon

The result is a best-effort *starting point* for calibration, not a
guarantee of pixel-perfect alignment - a rectangular floor-plan bounding box
can only approximate an irregular real building footprint (attached garden
centers, loading docks, canopies, ...). `calculate_alignment_error()` reports
how good the fit actually is so the UI never overstates it.
"""
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import List, Optional

import numpy as np
from pyproj import Transformer
from shapely.affinity import affine_transform
from shapely.geometry import Point, Polygon, shape

from backend.config import BUILDINGS_DIR, GEOREFERENCE_DIR
from backend.models import Anchor, ControlPoint, GeoreferenceFile, Layout, Transform
from backend.store_service import validate_store_id


class BuildingNotFoundError(Exception):
    pass


class GeoreferenceNotFoundError(Exception):
    pass


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------

def _building_path(store_id: str) -> Path:
    validate_store_id(store_id)
    path = (BUILDINGS_DIR / f"{store_id}.geojson").resolve()
    if BUILDINGS_DIR.resolve() not in path.parents:
        raise BuildingNotFoundError(f"Refusing to read outside buildings dir: {store_id!r}")
    return path


def load_building(store_id: str) -> dict:
    """Load the raw building-footprint GeoJSON FeatureCollection for a store."""
    path = _building_path(store_id)
    if not path.exists():
        raise BuildingNotFoundError(f"No building footprint on file for store_id: {store_id}")
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def load_floor_layout(store_id: str):
    """Load the raw (local-coordinate) floor layout for a store."""
    from backend import layout_service

    return layout_service.get_raw_layout(store_id)


def building_exists(store_id: str) -> bool:
    try:
        return _building_path(store_id).exists()
    except BuildingNotFoundError:
        return False


def _georeference_path(store_id: str) -> Path:
    validate_store_id(store_id)
    path = (GEOREFERENCE_DIR / f"{store_id}.json").resolve()
    if GEOREFERENCE_DIR.resolve() not in path.parents:
        raise GeoreferenceNotFoundError(f"Refusing to read outside georeference dir: {store_id!r}")
    return path


def load_georeference(store_id: str) -> GeoreferenceFile:
    """Load the saved control-point file for a store."""
    path = _georeference_path(store_id)
    if not path.exists():
        raise GeoreferenceNotFoundError(f"No georeference control points on file for store_id: {store_id}")
    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)
    return GeoreferenceFile.model_validate(raw)


def save_georeference(store_id: str, georeference: GeoreferenceFile) -> None:
    """Validate and persist a control-point file for a store."""
    validate_store_id(store_id)
    if georeference.store_id != store_id:
        raise ValueError("georeference.store_id does not match the URL store_id")
    path = _georeference_path(store_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(georeference.model_dump(), f, indent=2)


def validate_all_buildings() -> None:
    """Run on startup: validate every building footprint file on disk."""
    from backend.models import BuildingFeatureCollection

    if not BUILDINGS_DIR.exists():
        return
    for path in BUILDINGS_DIR.glob("*.geojson"):
        with open(path, "r", encoding="utf-8") as f:
            raw = json.load(f)
        BuildingFeatureCollection.model_validate(raw)


def validate_all_georeference() -> None:
    """Run on startup: validate every control-point file on disk."""
    if not GEOREFERENCE_DIR.exists():
        return
    for path in GEOREFERENCE_DIR.glob("*.json"):
        with open(path, "r", encoding="utf-8") as f:
            raw = json.load(f)
        GeoreferenceFile.model_validate(raw)


def fit_similarity_from_control_points(control_points: List[ControlPoint], anchor: Anchor) -> dict:
    """Closed-form least-squares 2D similarity fit (uniform scale + rotation
    + translation) from >=2 floor<->geo control point correspondences.

    Solved via complex-number linear least squares: with floor points
    z_i = x_i + i*y_i and their geo targets (projected to local AEQD meters)
    w_i = e_i + i*n_i, we solve for complex (a, b) minimizing
    sum |a*z_i + b - w_i|^2. a = s*e^{i*theta} directly encodes scale and
    rotation; b is the translation. This is the standard 2D Procrustes/
    Umeyama solution without reflection.
    """
    if len(control_points) < 2:
        raise ValueError("Need at least 2 control points to fit a transform")

    aeqd_crs = (
        f"+proj=aeqd +lat_0={anchor.latitude} +lon_0={anchor.longitude} "
        "+datum=WGS84 +units=m +no_defs"
    )
    to_local = Transformer.from_crs("EPSG:4326", aeqd_crs, always_xy=True)

    z = np.array([cp.floor.x + 1j * cp.floor.y for cp in control_points])
    w = []
    for cp in control_points:
        east, north = to_local.transform(cp.geo.longitude, cp.geo.latitude)
        w.append(east + 1j * north)
    w = np.array(w)

    # Solve [z_i, 1] @ [a, b]^T = w_i in the least-squares sense.
    A = np.column_stack([z, np.ones_like(z)])
    (a, b), *_ = np.linalg.lstsq(A, w, rcond=None)

    scale = abs(a)
    rotation_degrees = math.degrees(math.atan2(a.imag, a.real))

    predicted = A @ np.array([a, b])
    residuals = np.abs(predicted - w)
    rms_error_m = float(np.sqrt(np.mean(residuals ** 2)))

    return {
        "rotation_degrees": rotation_degrees,
        "scale_x": scale,
        "scale_y": scale,
        "offset_x": float(b.real),
        "offset_y": float(b.imag),
        "rms_error_m": rms_error_m,
    }


# ---------------------------------------------------------------------------
# Projection helpers (building footprint lon/lat -> local AEQD meters,
# centered on the store anchor, same convention as backend/transform.py)
# ---------------------------------------------------------------------------

def _to_local_polygon(building_geojson: dict, anchor: Anchor) -> Polygon:
    aeqd_crs = (
        f"+proj=aeqd +lat_0={anchor.latitude} +lon_0={anchor.longitude} "
        "+datum=WGS84 +units=m +no_defs"
    )
    to_local = Transformer.from_crs("EPSG:4326", aeqd_crs, always_xy=True)

    feature = building_geojson["features"][0]
    geom = shape(feature["geometry"])

    def project_ring(ring):
        return [to_local.transform(lon, lat) for lon, lat in ring]

    if geom.geom_type == "Polygon":
        exterior = project_ring(geom.exterior.coords)
        interiors = [project_ring(r.coords) for r in geom.interiors]
        return Polygon(exterior, interiors)
    if geom.geom_type == "MultiPolygon":
        # Use the largest sub-polygon as "the" building.
        polys = list(geom.geoms)
        polys.sort(key=lambda p: p.area, reverse=True)
        exterior = project_ring(polys[0].exterior.coords)
        interiors = [project_ring(r.coords) for r in polys[0].interiors]
        return Polygon(exterior, interiors)
    raise ValueError(f"Unsupported building geometry type: {geom.geom_type}")


def _floor_bbox_polygon(layout: Layout) -> Polygon:
    """Bounding box of every floor-plan geometry, in raw floor-plan units."""
    xs: list = []
    ys: list = []

    def walk(node, depth: int) -> None:
        if depth == 0:
            xs.append(node[0])
            ys.append(node[1])
            return
        for child in node:
            walk(child, depth - 1)

    depth_by_type = {
        "Point": 0,
        "LineString": 1,
        "MultiLineString": 2,
        "Polygon": 2,
        "MultiPolygon": 3,
    }

    for collection in (layout.departments, layout.aisles, layout.racks, layout.markers):
        for item in collection:
            geom = item.geometry
            walk(geom.coordinates, depth_by_type[geom.type])

    if not xs:
        raise ValueError("Floor layout has no geometry to bound")

    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    return Polygon([(min_x, min_y), (max_x, min_y), (max_x, max_y), (min_x, max_y)])


# ---------------------------------------------------------------------------
# Bounds
# ---------------------------------------------------------------------------

def calculate_building_bounds(building_geojson: dict, anchor: Anchor) -> dict:
    """Minimum rotated bounding rectangle of the building footprint, in
    local AEQD meters relative to `anchor`."""
    building_local = _to_local_polygon(building_geojson, anchor)
    mrr = building_local.minimum_rotated_rectangle
    corners = list(mrr.exterior.coords)[:-1]

    def dist(a, b):
        return math.hypot(a[0] - b[0], a[1] - b[1])

    edge_ab = dist(corners[0], corners[1])
    edge_bc = dist(corners[1], corners[2])
    width, height = (edge_ab, edge_bc) if edge_ab >= edge_bc else (edge_bc, edge_ab)
    angle_deg = math.degrees(
        math.atan2(corners[1][1] - corners[0][1], corners[1][0] - corners[0][0])
    )
    if edge_ab < edge_bc:
        angle_deg += 90.0

    return {
        "width_m": width,
        "height_m": height,
        "rotation_degrees": angle_deg,
        "area_m2": building_local.area,
        "centroid": {"x": building_local.centroid.x, "y": building_local.centroid.y},
        "corners_local_m": [{"x": c[0], "y": c[1]} for c in corners],
        "polygon_local_m": [[p[0], p[1]] for p in building_local.exterior.coords],
    }


def calculate_floor_bounds(layout: Layout) -> dict:
    """Bounding box of the floor plan, in floor-plan units and in meters
    (via the layout's own `transform.scale`)."""
    bbox = _floor_bbox_polygon(layout)
    min_x, min_y, max_x, max_y = bbox.bounds
    scale = layout.transform.scale
    return {
        "width_units": max_x - min_x,
        "height_units": max_y - min_y,
        "width_m": (max_x - min_x) * scale,
        "height_m": (max_y - min_y) * scale,
        "area_m2": (max_x - min_x) * (max_y - min_y) * scale * scale,
        "min_x": min_x,
        "min_y": min_y,
        "max_x": max_x,
        "max_y": max_y,
    }


# ---------------------------------------------------------------------------
# Transform search
# ---------------------------------------------------------------------------

def _rect_units(width: float, height: float) -> Polygon:
    """A (0,0)-(width,height) rectangle in raw floor/SVG units - NOT yet
    converted to meters. `scale_x`/`scale_y` below carry the full
    units-to-meters conversion, matching `Transform.scale_x`/`scale_y`
    semantics (they override `transform.scale`, they don't multiply it)."""
    return Polygon([(0, 0), (width, 0), (width, height), (0, height)])


def _floor_rect_units(layout: Layout) -> Polygon:
    """Floor-plan (GeoJSON department/aisle/rack/marker) bounding box in raw
    floor-plan units (feet, etc)."""
    bounds = calculate_floor_bounds(layout)
    return _rect_units(bounds["width_units"], bounds["height_units"])


def _apply_similarity(poly: Polygon, rotation_deg: float, scale_x: float, scale_y: float,
                       offset_x: float, offset_y: float) -> Polygon:
    theta = math.radians(rotation_deg)
    c, s = math.cos(theta), math.sin(theta)
    a, b = c * scale_x, -s * scale_y
    d, e = s * scale_x, c * scale_y
    return affine_transform(poly, [a, b, d, e, offset_x, offset_y])


def _iou(a: Polygon, b: Polygon) -> float:
    inter = a.intersection(b).area
    union = a.union(b).area
    return inter / union if union > 0 else 0.0


def calculate_initial_transform_for_dimensions(
    building_geojson: dict, anchor: Anchor, width: float, height: float, nominal_scale: float = 1.0
) -> dict:
    """Coarse similarity transform matching a (width x height) rectangle
    (floor-plan units, or SVG pixel units) to the building's minimum rotated
    rectangle. Tries both axis correspondences (rect-width-to-building-long-
    axis and rect-width-to-building-short-axis) and a scale sweep, scored by
    IoU against the real building polygon (not just its bounding rectangle).
    """
    building_local = _to_local_polygon(building_geojson, anchor)
    building_bounds = calculate_building_bounds(building_geojson, anchor)
    base_angle = building_bounds["rotation_degrees"]
    bcx, bcy = building_bounds["centroid"]["x"], building_bounds["centroid"]["y"]

    rect = _rect_units(width, height)

    best = None
    for angle_candidate in (base_angle, base_angle + 90.0):
        for scale_step in range(30, 301, 3):  # 0.30x .. 3.00x of the nominal units->meters scale
            scale = nominal_scale * (scale_step / 100.0)
            cand = _apply_similarity(rect, angle_candidate, scale, scale, 0.0, 0.0)
            ccx, ccy = cand.centroid.x, cand.centroid.y
            tx, ty = bcx - ccx, bcy - ccy
            cand = _apply_similarity(rect, angle_candidate, scale, scale, tx, ty)
            score = _iou(cand, building_local)
            if best is None or score > best[0]:
                best = (score, angle_candidate, scale, scale, tx, ty)

    score, rotation, scale_x, scale_y, offset_x, offset_y = best
    return {
        "rotation_degrees": rotation,
        "scale_x": scale_x,
        "scale_y": scale_y,
        "offset_x": offset_x,
        "offset_y": offset_y,
        "iou": score,
    }


def optimize_transform_for_dimensions(
    initial: dict, building_geojson: dict, anchor: Anchor, width: float, height: float,
    max_iterations: int = 200,
) -> dict:
    """Coordinate-descent refinement of `initial`, maximizing IoU between the
    transformed (width x height) rectangle and the real building polygon."""
    building_local = _to_local_polygon(building_geojson, anchor)
    rect = _rect_units(width, height)

    params = [
        initial["rotation_degrees"],
        initial["scale_x"],
        initial["scale_y"],
        initial["offset_x"],
        initial["offset_y"],
    ]
    steps = [2.0, initial["scale_x"] * 0.15, initial["scale_y"] * 0.15, 3.0, 3.0]

    def score_of(p) -> float:
        cand = _apply_similarity(rect, p[0], p[1], p[2], p[3], p[4])
        return _iou(cand, building_local)

    best_score = score_of(params)
    for _ in range(max_iterations):
        improved = False
        for i in range(5):
            for direction in (1, -1):
                trial = list(params)
                trial[i] += direction * steps[i]
                if trial[1] <= 0 or trial[2] <= 0:
                    continue
                trial_score = score_of(trial)
                if trial_score > best_score + 1e-9:
                    params = trial
                    best_score = trial_score
                    improved = True
        if not improved:
            steps = [s * 0.5 for s in steps]
            if max(steps) < 1e-4:
                break

    rotation, scale_x, scale_y, offset_x, offset_y = params
    return {
        "rotation_degrees": rotation,
        "scale_x": scale_x,
        "scale_y": scale_y,
        "offset_x": offset_x,
        "offset_y": offset_y,
        "iou": best_score,
    }


def calculate_initial_transform(building_geojson: dict, layout: Layout) -> dict:
    """Layout-based (GeoJSON department/aisle/rack/marker) wrapper around
    calculate_initial_transform_for_dimensions()."""
    bounds = calculate_floor_bounds(layout)
    return calculate_initial_transform_for_dimensions(
        building_geojson, layout.anchor, bounds["width_units"], bounds["height_units"],
        nominal_scale=layout.transform.scale,
    )


def optimize_transform(initial: dict, building_geojson: dict, layout: Layout,
                        max_iterations: int = 200) -> dict:
    """Layout-based wrapper around optimize_transform_for_dimensions()."""
    bounds = calculate_floor_bounds(layout)
    return optimize_transform_for_dimensions(
        initial, building_geojson, layout.anchor, bounds["width_units"], bounds["height_units"],
        max_iterations=max_iterations,
    )


# ---------------------------------------------------------------------------
# Apply / error reporting
# ---------------------------------------------------------------------------

def apply_transform(x: float, y: float, transform: Transform) -> tuple:
    """Floor-plan (x, y) -> local AEQD meters (east, north), using the given
    transform's scale_x/scale_y/rotation/offset. Delegates to the same
    floor_to_local + rotate/offset pipeline used for actual map rendering
    (backend/transform.py), so alignment math and render math never drift
    apart."""
    from backend.transform import apply_rotation_and_offset, floor_to_local

    mx, my = floor_to_local(x, y, transform)
    return apply_rotation_and_offset(mx, my, transform)


def calculate_alignment_error(building_geojson: dict, layout: Layout,
                               transform: Optional[Transform] = None) -> dict:
    """Compare the floor plan (under `transform`, or the layout's own saved
    transform if omitted) against the real building footprint.

    alignment_error_m is the mean distance from each corner of the
    transformed floor-plan bounding box to the nearest point on the real
    building's outline - a simple, honest "how many meters off" number.
    """
    anchor = layout.anchor
    transform = transform or layout.transform

    building_local = _to_local_polygon(building_geojson, anchor)
    building_bounds = calculate_building_bounds(building_geojson, anchor)
    floor_bounds = calculate_floor_bounds(layout)

    scale_x = transform.scale_x if transform.scale_x is not None else transform.scale
    scale_y = transform.scale_y if transform.scale_y is not None else transform.scale
    w = floor_bounds["width_units"] * scale_x
    h = floor_bounds["height_units"] * scale_y
    floor_rect = Polygon([(0, 0), (w, 0), (w, h), (0, h)])

    cand = _apply_similarity(
        floor_rect, transform.rotation_degrees, 1.0, 1.0,
        transform.offset_x, transform.offset_y,
    )

    boundary = building_local.exterior
    corner_errors = [boundary.distance(Point(x, y)) for x, y in cand.exterior.coords[:-1]]
    alignment_error_m = sum(corner_errors) / len(corner_errors) if corner_errors else None

    return {
        "alignment_error_m": alignment_error_m,
        "building_area_m2": building_bounds["area_m2"],
        "floor_plan_area_m2": floor_bounds["area_m2"],
        "building_width_m": building_bounds["width_m"],
        "building_height_m": building_bounds["height_m"],
        "floor_plan_width_m": floor_bounds["width_m"],
        "floor_plan_height_m": floor_bounds["height_m"],
        "scale_x": scale_x,
        "scale_y": scale_y,
        "rotation_degrees": transform.rotation_degrees,
        "iou": _iou(cand, building_local),
    }


# ---------------------------------------------------------------------------
# SVG floor-plan overlay georeferencing
# ---------------------------------------------------------------------------
#
# The uploaded floor-plan SVG is a second, independent "floor unit" space
# (its own pixel width/height), geo-referenced with its own Transform,
# separate from the GeoJSON department/aisle/rack/marker layout's transform.
# Everything above (bounding-box auto-align, control-point similarity fit)
# is dimension-agnostic, so it's reused here with the SVG's width/height in
# place of the GeoJSON layout's floor bounds.

def corners_to_control_points(corners: dict, width: float, height: float) -> List[ControlPoint]:
    """Convert a {"top_left": GeoPoint|None, ...} corner dict (SVG pixel
    corners (0,0)/(w,0)/(w,h)/(0,h)) into a ControlPoint list, skipping any
    corner that hasn't been set yet."""
    from backend.models import FloorPoint, GeoPoint

    corner_floor_xy = {
        "top_left": (0.0, 0.0),
        "top_right": (width, 0.0),
        "bottom_right": (width, height),
        "bottom_left": (0.0, height),
    }
    points = []
    for name, geo in corners.items():
        if geo is None:
            continue
        x, y = corner_floor_xy[name]
        geo_point = geo if isinstance(geo, GeoPoint) else GeoPoint.model_validate(geo)
        points.append(ControlPoint(name=name, floor=FloorPoint(x=x, y=y), geo=geo_point))
    return points


def svg_reference_corners(svg_transform: Transform, anchor: Anchor, width: float, height: float) -> dict:
    """Compute the (top_left, top_right, bottom_left) geographic corners of
    the SVG overlay under its saved transform, using the same authoritative
    AEQD pipeline as everything else (backend/transform.py). These three
    points fully determine the SVG's placement, scale, and rotation on the
    map - the frontend positions the overlay from them directly, without
    reimplementing the projection in JS."""
    from backend.transform import floor_to_latlon

    corners = {}
    for name, (x, y) in (
        ("top_left", (0.0, 0.0)),
        ("top_right", (width, 0.0)),
        ("bottom_left", (0.0, height)),
    ):
        lat, lon = floor_to_latlon(x, y, svg_transform, anchor)
        corners[name] = {"latitude": lat, "longitude": lon}
    return corners


def calculate_initial_svg_transform(building_geojson: dict, anchor: Anchor, width: float, height: float) -> dict:
    """Auto-align entry point for the SVG overlay: same bounding-box-match +
    IoU-optimization pipeline used for the GeoJSON layout, parameterized by
    the SVG's own pixel width/height instead of the layout's floor bounds."""
    initial = calculate_initial_transform_for_dimensions(building_geojson, anchor, width, height)
    return optimize_transform_for_dimensions(initial, building_geojson, anchor, width, height)
