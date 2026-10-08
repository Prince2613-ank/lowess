"""Validate complete layered responses without discarding source fields."""
import math


def collections(value, path=""):
    if isinstance(value, dict):
        if value.get("type") == "FeatureCollection":
            yield path or "features", value
        else:
            for key, child in value.items():
                yield from collections(child, f"{path}/{key}".strip("/"))
    elif isinstance(value, list):
        for i, child in enumerate(value):
            yield from collections(child, f"{path}/{i}")


def position(value):
    if not isinstance(value, list) or len(value) < 2:
        raise ValueError("Invalid coordinate position")
    if any(isinstance(n, bool) or not isinstance(n, (int, float)) or not math.isfinite(n) for n in value):
        raise ValueError("Non-finite or non-numeric coordinate")
    if not -180 <= value[0] <= 180 or not -90 <= value[1] <= 90:
        raise ValueError("Coordinates are outside longitude/latitude ranges")


def geometry(g):
    if not isinstance(g, dict):
        raise ValueError("Missing geometry")
    kind, coords = g.get("type"), g.get("coordinates")
    # RFC 7946 permits empty coordinate arrays (equivalent to null geometry).
    if coords == [] and kind in ("Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"):
        return
    if kind == "GeometryCollection":
        if not isinstance(g.get("geometries"), list):
            raise ValueError("Invalid GeometryCollection")
        for child in g["geometries"]:
            geometry(child)
        return
    def line(c, minimum=2, ring=False):
        if not isinstance(c, list) or len(c) < minimum:
            raise ValueError("Too few line/ring coordinates")
        for p in c:
            position(p)
        if ring and c[0] != c[-1]:
            raise ValueError("Polygon ring is not closed")
    def polygon(c):
        if not isinstance(c, list) or not c:
            raise ValueError("Empty polygon")
        for ring in c:
            line(ring, 4, True)
    if kind == "Point":
        position(coords)
    elif kind == "MultiPoint":
        line(coords, 1)
    elif kind == "LineString":
        line(coords)
    elif kind == "Polygon":
        polygon(coords)
    elif kind in ("MultiLineString", "MultiPolygon"):
        if not isinstance(coords, list) or not coords:
            raise ValueError("Empty multi geometry")
        for child in coords:
            (line if kind == "MultiLineString" else polygon)(child)
    else:
        raise ValueError(f"Unsupported geometry: {kind}")


def validate(value):
    counts = {}
    for name, fc in collections(value):
        features = fc.get("features")
        if not isinstance(features, list):
            raise ValueError(f"{name}: features must be an array")
        for f in features:
            if not isinstance(f, dict) or f.get("type") != "Feature":
                raise ValueError(f"{name}: invalid Feature")
            if "geometry" not in f:
                raise ValueError(f"{name}: missing Feature geometry")
            if f.get("properties") is not None and not isinstance(f["properties"], dict):
                raise ValueError(f"{name}: invalid properties")
            # Null geometry is allowed by GeoJSON, but cannot be rendered.
            if f.get("geometry") is not None:
                geometry(f["geometry"])
        counts[name] = len(features)
    if not counts or not sum(counts.values()):
        raise ValueError("No nonempty GeoJSON FeatureCollections found")
    return counts
