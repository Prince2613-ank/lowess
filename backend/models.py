"""
Pydantic models for stores, transform configuration, and floor-layout data.

These double as the validation layer: anything that doesn't fit these
shapes is rejected before it ever reaches the transformation engine.
"""
from __future__ import annotations

import math
from typing import Dict, List, Literal, Optional, Union

from pydantic import BaseModel, Field, field_validator, model_validator


# ---------------------------------------------------------------------------
# Transform / anchor configuration (per-store calibration) - defined before
# Store/StoreGeoreference below since they reference Anchor.
# ---------------------------------------------------------------------------

class Anchor(BaseModel):
    """The real-world geographic point that the floor plan's local origin
    (after scale/rotation/offset) is anchored to."""

    latitude: float
    longitude: float

    @field_validator("latitude")
    @classmethod
    def _valid_lat(cls, v: float) -> float:
        if math.isnan(v) or not (-90.0 <= v <= 90.0):
            raise ValueError(f"invalid anchor latitude: {v!r}")
        return v

    @field_validator("longitude")
    @classmethod
    def _valid_lon(cls, v: float) -> float:
        if math.isnan(v) or not (-180.0 <= v <= 180.0):
            raise ValueError(f"invalid anchor longitude: {v!r}")
        return v


# ---------------------------------------------------------------------------
# Store directory (data/stores.json)
# ---------------------------------------------------------------------------

class StoreGeoreference(BaseModel):
    """Informational summary of a store's current georeferencing, mirrored
    into stores.json for visibility. The authoritative values actually used
    for rendering live in the layout file's own anchor/transform
    (data/layouts/{store_id}.json) - this block is kept in sync with it by
    the calibration/auto-align endpoints, not read directly by the
    rendering pipeline."""

    method: Literal["affine", "similarity"] = "affine"
    source_crs: Literal["local"] = "local"
    target_crs: Literal["EPSG:4326"] = "EPSG:4326"
    anchor: Anchor
    rotation_degrees: float = 0.0
    scale_x: float = 1.0
    scale_y: float = 1.0
    offset_x: float = 0.0
    offset_y: float = 0.0

    @field_validator("scale_x", "scale_y")
    @classmethod
    def _scale_positive(cls, v: float) -> float:
        if math.isnan(v) or v <= 0:
            raise ValueError("scale_x/scale_y must be positive, non-NaN numbers")
        return v

    @field_validator("rotation_degrees", "offset_x", "offset_y")
    @classmethod
    def _no_nan(cls, v: float) -> float:
        if math.isnan(v):
            raise ValueError("transform values must not be NaN")
        return v


class Store(BaseModel):
    store_id: str = Field(..., min_length=1, max_length=32)
    name: str
    address: str
    latitude: float
    longitude: float
    layout_id: str = Field(..., min_length=1, max_length=32)
    building_id: Optional[str] = Field(default=None, min_length=1, max_length=32)
    georeference: Optional[StoreGeoreference] = None

    @field_validator("latitude")
    @classmethod
    def _valid_lat(cls, v: float) -> float:
        if math.isnan(v) or not (-90.0 <= v <= 90.0):
            raise ValueError(f"invalid latitude: {v!r}")
        return v

    @field_validator("longitude")
    @classmethod
    def _valid_lon(cls, v: float) -> float:
        if math.isnan(v) or not (-180.0 <= v <= 180.0):
            raise ValueError(f"invalid longitude: {v!r}")
        return v

    @field_validator("store_id", "layout_id")
    @classmethod
    def _non_empty(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("store_id / layout_id must not be empty")
        return v


class Transform(BaseModel):
    """Configurable per-store calibration between floor-plan units and
    real-world meters.

    `scale` is the uniform (legacy) scale used by the simple calibration UI.
    `scale_x` / `scale_y`, when set, override it per-axis - this is what a
    similarity/affine building-alignment transform (see backend/georeference.py)
    typically needs, since a simplified rectangular floor plan rarely matches
    a real building's aspect ratio exactly."""

    scale: float = 1.0          # floor-plan units -> meters (uniform default)
    scale_x: Optional[float] = None  # overrides `scale` on the x axis, if set
    scale_y: Optional[float] = None  # overrides `scale` on the y axis, if set
    rotation_degrees: float = 0.0  # counter-clockwise rotation applied in meter-space
    offset_x: float = 0.0       # meters, applied after scale+rotation (east-ish)
    offset_y: float = 0.0       # meters, applied after scale+rotation (north-ish)

    @field_validator("scale")
    @classmethod
    def _scale_positive(cls, v: float) -> float:
        if math.isnan(v) or v <= 0:
            raise ValueError("scale must be a positive, non-NaN number")
        return v

    @field_validator("scale_x", "scale_y")
    @classmethod
    def _scale_xy_positive(cls, v: Optional[float]) -> Optional[float]:
        if v is None:
            return v
        if math.isnan(v) or v <= 0:
            raise ValueError("scale_x/scale_y must be positive, non-NaN numbers")
        return v

    @field_validator("rotation_degrees", "offset_x", "offset_y")
    @classmethod
    def _no_nan(cls, v: float) -> float:
        if math.isnan(v):
            raise ValueError("transform values must not be NaN")
        return v


# ---------------------------------------------------------------------------
# GeoJSON-like geometry (floor-plan local coordinates: [x, y])
# ---------------------------------------------------------------------------

Coordinate = List[float]  # [x, y] in floor-plan local units


class Geometry(BaseModel):
    type: Literal["Point", "LineString", "MultiLineString", "Polygon", "MultiPolygon"]
    # Nesting depth depends on `type`; validated generically below.
    coordinates: Union[
        Coordinate,
        List[Coordinate],
        List[List[Coordinate]],
        List[List[List[Coordinate]]],
    ]

    @model_validator(mode="after")
    def _validate_shape_and_values(self) -> "Geometry":
        def check_point(pt) -> None:
            if not isinstance(pt, (list, tuple)) or len(pt) < 2:
                raise ValueError(f"invalid coordinate pair: {pt!r}")
            x, y = pt[0], pt[1]
            for val in (x, y):
                if not isinstance(val, (int, float)) or isinstance(val, bool):
                    raise ValueError(f"non-numeric coordinate: {pt!r}")
                if math.isnan(val) or math.isinf(val):
                    raise ValueError(f"NaN/Inf coordinate: {pt!r}")

        def walk(node, depth: int) -> None:
            if depth == 0:
                check_point(node)
                return
            if not isinstance(node, list) or len(node) == 0:
                raise ValueError("empty or malformed geometry coordinates")
            for child in node:
                walk(child, depth - 1)

        depth_by_type = {
            "Point": 0,
            "LineString": 1,
            "MultiLineString": 2,
            "Polygon": 2,
            "MultiPolygon": 3,
        }
        walk(self.coordinates, depth_by_type[self.type])
        return self


# ---------------------------------------------------------------------------
# Layout entities
# ---------------------------------------------------------------------------

class Department(BaseModel):
    id: str
    name: str
    category: Optional[str] = None
    geometry: Geometry
    label: Optional[str] = None
    color: Optional[str] = None


class Aisle(BaseModel):
    id: str
    name: str
    department_id: Optional[str] = None
    geometry: Geometry
    label: Optional[str] = None


class Rack(BaseModel):
    id: str
    name: Optional[str] = None
    aisle_id: Optional[str] = None
    geometry: Geometry
    info: Optional[str] = None


MarkerCategory = Literal[
    "basic_information",
    "store_service",
    "label",
]

BasicInfoType = Literal[
    "returns",
    "restrooms",
    "checkouts",
    "store_pickup",
    "entrance_exit",
    "pickup_lockers",
    "pro_service_desk",
    "customer_service_desk",
]

StoreServiceType = Literal[
    "key_copying",
    "millwork_desk",
    "wood_cutting",
    "wire_cutting",
    "flooring_desk",
    "blind_cutting",
    "glass_cutting",
    "carpet_cutting",
    "appliance_desk",
    "home_decor_desk",
    "chain_rope_cutting",
    "kitchen_design_desk",
]


class Marker(BaseModel):
    id: str
    category: MarkerCategory
    marker_type: str  # one of BasicInfoType / StoreServiceType, or free text for "label"
    label: Optional[str] = None
    icon: Optional[str] = None
    geometry: Geometry
    min_zoom: Optional[int] = None  # if set, marker only renders at zoom >= this


class Layout(BaseModel):
    store_id: str = Field(..., min_length=1, max_length=32)
    coordinate_system: Literal["local"] = "local"
    anchor: Anchor
    transform: Transform = Transform()
    departments: List[Department] = []
    aisles: List[Aisle] = []
    racks: List[Rack] = []
    markers: List[Marker] = []

    @field_validator("store_id")
    @classmethod
    def _non_empty(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("store_id must not be empty")
        return v


# ---------------------------------------------------------------------------
# Building footprint (data/buildings/{store_id}.geojson) - real-world
# geographic GeoJSON (WGS84 lon/lat), NOT floor-plan local coordinates.
# ---------------------------------------------------------------------------

GeoRing = List[List[float]]  # [[lon, lat], ...]


class GeoPolygonGeometry(BaseModel):
    """A GeoJSON Polygon/MultiPolygon in WGS84 lon/lat, validated for
    coordinate order, range, and NaN/Inf - this is what makes it safe to
    trust building-footprint data pulled from an external source."""

    type: Literal["Polygon", "MultiPolygon"]
    coordinates: Union[List[GeoRing], List[List[GeoRing]]]

    @model_validator(mode="after")
    def _validate_rings(self) -> "GeoPolygonGeometry":
        def check_point(pt) -> None:
            if not isinstance(pt, (list, tuple)) or len(pt) < 2:
                raise ValueError(f"invalid [lon, lat] pair: {pt!r}")
            lon, lat = pt[0], pt[1]
            for val in (lon, lat):
                if not isinstance(val, (int, float)) or isinstance(val, bool):
                    raise ValueError(f"non-numeric coordinate: {pt!r}")
                if math.isnan(val) or math.isinf(val):
                    raise ValueError(f"NaN/Inf coordinate: {pt!r}")
            if not (-180.0 <= lon <= 180.0):
                raise ValueError(f"longitude out of range: {lon!r}")
            if not (-90.0 <= lat <= 90.0):
                raise ValueError(f"latitude out of range: {lat!r}")

        def check_ring(ring) -> None:
            if not isinstance(ring, list) or len(ring) < 4:
                raise ValueError("polygon ring must have at least 4 points (closed)")
            for pt in ring:
                check_point(pt)

        if self.type == "Polygon":
            for ring in self.coordinates:
                check_ring(ring)
        else:  # MultiPolygon
            for polygon in self.coordinates:
                for ring in polygon:
                    check_ring(ring)
        return self


class BuildingFeature(BaseModel):
    type: Literal["Feature"] = "Feature"
    properties: dict = {}
    geometry: GeoPolygonGeometry


class BuildingFeatureCollection(BaseModel):
    type: Literal["FeatureCollection"] = "FeatureCollection"
    metadata: Optional[dict] = None
    features: List[BuildingFeature] = Field(..., min_length=1)


# ---------------------------------------------------------------------------
# Control-point georeferencing (data/georeference/{store_id}.json)
# ---------------------------------------------------------------------------

class FloorPoint(BaseModel):
    x: float
    y: float

    @field_validator("x", "y")
    @classmethod
    def _no_nan(cls, v: float) -> float:
        if math.isnan(v) or math.isinf(v):
            raise ValueError("floor point coordinates must not be NaN/Inf")
        return v


class GeoPoint(BaseModel):
    latitude: float
    longitude: float

    @field_validator("latitude")
    @classmethod
    def _valid_lat(cls, v: float) -> float:
        if math.isnan(v) or not (-90.0 <= v <= 90.0):
            raise ValueError(f"invalid latitude: {v!r}")
        return v

    @field_validator("longitude")
    @classmethod
    def _valid_lon(cls, v: float) -> float:
        if math.isnan(v) or not (-180.0 <= v <= 180.0):
            raise ValueError(f"invalid longitude: {v!r}")
        return v


class ControlPoint(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)
    floor: FloorPoint
    geo: GeoPoint


class SvgInfo(BaseModel):
    """The uploaded, authoritative floor-plan SVG for a store - preserved as
    vector data, never rasterized. `width`/`height` are the SVG's own pixel
    coordinate system (its own local "floor units"), independent of the
    GeoJSON department/aisle/rack/marker layout's own local units."""

    file: str = Field(..., min_length=1, max_length=255)
    width: float
    height: float

    @field_validator("width", "height")
    @classmethod
    def _positive(cls, v: float) -> float:
        if math.isnan(v) or v <= 0:
            raise ValueError("svg width/height must be positive, non-NaN numbers")
        return v

    @field_validator("file")
    @classmethod
    def _no_path_traversal(cls, v: str) -> str:
        if "/" in v or "\\" in v or ".." in v:
            raise ValueError("svg file must be a plain filename, no path segments")
        return v


CornerName = Literal["top_left", "top_right", "bottom_right", "bottom_left"]


class GeoreferenceFile(BaseModel):
    store_id: str = Field(..., min_length=1, max_length=32)
    source: Literal["auto_align", "manual"] = "manual"
    control_points: List[ControlPoint] = []

    # SVG floor-plan overlay (data/layout-images/{store_id}.svg or similar) -
    # georeferenced independently of the GeoJSON layout's own transform,
    # since the SVG's pixel scale/aspect has no fixed relationship to the
    # GeoJSON floor units.
    svg: Optional[SvgInfo] = None
    transform: Optional[Transform] = None  # the SVG overlay's scale/rotation/offset (meters)
    svg_opacity: float = 1.0
    corners: Dict[CornerName, Optional[GeoPoint]] = Field(
        default_factory=lambda: {
            "top_left": None,
            "top_right": None,
            "bottom_right": None,
            "bottom_left": None,
        }
    )

    @field_validator("svg_opacity")
    @classmethod
    def _opacity_range(cls, v: float) -> float:
        if math.isnan(v) or not (0.0 <= v <= 1.0):
            raise ValueError("svg_opacity must be between 0.0 and 1.0")
        return v
