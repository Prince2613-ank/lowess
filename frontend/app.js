/* ==========================================================================
 * Lowe's Interactive Store Map - frontend application logic.
 *
 * Talks to the FastAPI backend for the store directory and renders the raw
 * Lowes_*.geojson floor plan on a MapLibre map over Esri satellite imagery
 * (or OpenStreetMap tiles).
 * ========================================================================== */

const DEFAULT_CENTER = [-98.35, 39.5]; // [lng, lat]

// MapLibre measures zoom with 512px tiles where Leaflet used 256px ones, so
// the same on-screen scale is one zoom level lower here. Every level below is
// the old Leaflet level minus one, which keeps views and thresholds identical.
const DEFAULT_ZOOM = 17;
const OVERVIEW_ZOOM = 3;

// Zoom thresholds driving progressive level-of-detail (see spec).
const ZOOM = {
    STORE_LEVEL: 17,
    DEPT_LABELS: 17,
    DEPT_LABELS_ALL: 19,
    AISLE_LABELS: 17,
    RACK_DETAIL: 21,
    MAX_DETAIL: 22,
};

const BASIC_INFO_ICONS = {
    returns: "↩",              // ↩
    restrooms: "🚻",       // 🚻
    checkouts: "💳",       // 💳
    store_pickup: "📦",    // 📦
    entrance_exit: "🚪",   // 🚪
    pickup_lockers: "🔐",  // 🔐
    pro_service_desk: "👷", // 👷
    customer_service_desk: "ℹ", // ℹ
};

const STORE_SERVICE_ICONS = {
    key_copying: "🔑",       // 🔑
    millwork_desk: "🛋",     // 🛋
    wood_cutting: "🪚",       // 🪚
    wire_cutting: "⚡",            // ⚡
    flooring_desk: "📐",      // 📐
    blind_cutting: "🪟",      // 🪟
    glass_cutting: "🕳",      // 🕳ish - pane
    carpet_cutting: "✂",          // ✂
    appliance_desk: "🔌",     // 🔌
    home_decor_desk: "🏠",    // 🏠
    chain_rope_cutting: "⛓",       // ⛓
    kitchen_design_desk: "🍽", // 🍽
};

const FLOORPLAN_LAYER_KEYS = [
    "departments", "departmentLines", "departmentPoints", "aisles",
    "aisleLines", "aislePoints", "racks", "rackLines",
];

// Vector floor-plan layers, bottom to top. Polygon groups get a fill plus an
// outline; line groups only a line. Colours match the former Leaflet styles
// and per-feature `fill`, `stroke`, `stroke-width` and `opacity` still win.
const FLOORPLAN_STYLES = {
    departments: { color: "#96A3BD", weight: 1, fillColor: "#D9E2F6", fillOpacity: 0.75 },
    aisles: { color: "#BBBBBB", weight: 1, fillColor: "#DCDEE2", fillOpacity: 0.7 },
    racks: { color: "#9ca3af", weight: 1, fillColor: "#DCDEE2", fillOpacity: 0.8 },
    departmentLines: { color: "#6b7280", weight: 1.5, opacity: 0.95 },
    aisleLines: { color: "#8b949e", weight: 1, opacity: 0.9 },
    rackLines: { color: "#4b5563", weight: 0.8, opacity: 0.85 },
};

// Leaflet's default path style, used for features outside the known layers.
const EXTRA_COLOR = "#3388ff";

const emptyCollection = () => ({ type: "FeatureCollection", features: [] });

function iconFor(category, markerType) {
    if (category === "basic_information") return BASIC_INFO_ICONS[markerType] || "ℹ";
    if (category === "store_service") return STORE_SERVICE_ICONS[markerType] || "🔧";
    return "•";
}

function humanize(s) {
    if (!s) return "";
    return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/* ---------------------------------------------------------------------- */
/* HTML markers                                                           */
/* ---------------------------------------------------------------------- */

// A set of maplibregl.Markers shown and hidden together, like a Leaflet
// layerGroup. Markers are only attached to the map while visible.
class MarkerGroup {
    constructor() {
        this.markers = [];
    }

    addLayer(marker) {
        this.markers.push(marker);
        return this;
    }

    getLayers() {
        return [...this.markers];
    }

    clearLayers() {
        this.markers.forEach((marker) => marker.remove());
        this.markers = [];
    }

    setVisible(visible, filter = () => true) {
        for (const marker of this.markers) {
            const show = visible && filter(marker);
            if (show && !marker._shown) marker.addTo(state.map);
            if (!show && marker._shown) marker.remove();
            marker._shown = show;
        }
    }
}

function popupContent(title, detail = "") {
    const content = document.createElement("div");
    const heading = document.createElement("b");
    heading.textContent = title;
    content.append(heading);
    if (detail) content.append(document.createTextNode(detail));
    return content;
}

function labelMarker(lngLat, className, text) {
    const element = document.createElement("div");
    element.className = className;
    element.textContent = text;
    return new maplibregl.Marker({ element, anchor: "top-left" }).setLngLat(lngLat);
}

function iconMarker(lngLat, category, emoji) {
    const element = document.createElement("div");
    const icon = document.createElement("div");
    icon.className = `marker-icon ${category}`;
    icon.textContent = emoji;
    element.append(icon);
    return new maplibregl.Marker({ element, anchor: "center" }).setLngLat(lngLat);
}

/* ---------------------------------------------------------------------- */
/* Geometry helpers                                                       */
/* ---------------------------------------------------------------------- */

function forEachPosition(coordinates, callback) {
    if (!Array.isArray(coordinates)) return;
    if (coordinates.length >= 2 && typeof coordinates[0] === "number" && typeof coordinates[1] === "number") {
        callback(coordinates);
        return;
    }
    coordinates.forEach((child) => forEachPosition(child, callback));
}

function geometryBounds(geometry, bounds = new maplibregl.LngLatBounds()) {
    if (!geometry) return bounds;
    if (geometry.type === "GeometryCollection") {
        (geometry.geometries || []).forEach((child) => geometryBounds(child, bounds));
        return bounds;
    }
    forEachPosition(geometry.coordinates, (position) => bounds.extend([position[0], position[1]]));
    return bounds;
}

function featuresBounds(features, bounds = new maplibregl.LngLatBounds()) {
    for (const feature of features || []) geometryBounds(feature.geometry, bounds);
    return bounds;
}

function boundsAreValid(bounds) {
    return Boolean(bounds && bounds.getSouthWest && !bounds.isEmpty());
}

// Leaflet's LatLngBounds.pad(): grow every side by `ratio` of the span.
function padBounds(bounds, ratio) {
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    const dx = (ne.lng - sw.lng) * ratio;
    const dy = (ne.lat - sw.lat) * ratio;
    return new maplibregl.LngLatBounds([sw.lng - dx, sw.lat - dy], [ne.lng + dx, ne.lat + dy]);
}

// Fit like Leaflet did: whole zoom levels only, so satellite tiles stay sharp.
function fitMapBounds(bounds, maxZoom, animate = false) {
    const camera = state.map.cameraForBounds(bounds, { padding: 0, maxZoom });
    if (!camera) return;
    const view = { center: camera.center, zoom: Math.floor(camera.zoom), bearing: 0 };
    if (animate) state.map.easeTo(view);
    else state.map.jumpTo(view);
}

/* ---------------------------------------------------------------------- */
/* App state                                                              */
/* ---------------------------------------------------------------------- */

const state = {
    map: null,
    stores: [],
    currentStoreId: null,
    currentStore: null,

    layers: {
        data: Object.fromEntries(FLOORPLAN_LAYER_KEYS.map((key) => [key, emptyCollection()])),
        deptLabels: new MarkerGroup(),
        aisleLabels: new MarkerGroup(),
        rackLabels: new MarkerGroup(),
        markers: [],   // array of {layer, minZoom}
        markerGroup: new MarkerGroup(),
        storePin: null,
    },
};

function applyPanelCollapseState(panelId, collapsed) {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    panel.classList.toggle('collapsed', collapsed);
    const button = panel.querySelector('.panel-toggle');
    if (button) {
        button.textContent = collapsed ? '+' : '−';
        button.setAttribute('aria-label', collapsed ? `Expand ${panelId} panel` : `Collapse ${panelId} panel`);
        button.setAttribute('aria-expanded', String(!collapsed));
    }
    try {
        sessionStorage.setItem(`map-panel:${panelId}:collapsed`, String(collapsed));
    } catch (error) {
        console.warn('Could not save panel collapse state:', error);
    }
}

function wireCollapsiblePanels() {
    document.querySelectorAll('.panel-toggle').forEach((button) => {
        const panelId = button.dataset.panel;
        const panel = document.getElementById(panelId);
        if (!panel) return;

        let collapsed = false;
        try {
            collapsed = sessionStorage.getItem(`map-panel:${panelId}:collapsed`) === 'true';
        } catch (error) {
            console.warn('Could not read panel collapse state:', error);
        }
        applyPanelCollapseState(panelId, collapsed);

        button.addEventListener('click', () => {
            const nextCollapsed = !panel.classList.contains('collapsed');
            applyPanelCollapseState(panelId, nextCollapsed);
            if (state.map) {
                window.setTimeout(() => state.map.resize(), 50);
            }
        });
    });
}

/* ---------------------------------------------------------------------- */
/* Map bootstrap                                                          */
/* ---------------------------------------------------------------------- */

function colorValue(property, fallback) {
    return ["to-color", ["coalesce", ["get", property], fallback], fallback];
}

function strokeWidthValue(fallback) {
    const width = ["to-number", ["get", "stroke-width"], 0];
    return ["case", [">", width, 0], width, fallback];
}

function fillOpacityValue(fallback) {
    return ["case", ["==", ["get", "opacity"], null], fallback, ["to-number", ["get", "opacity"], fallback]];
}

function floorplanLayers() {
    const layers = [];
    for (const [key, style] of Object.entries(FLOORPLAN_STYLES)) {
        if (style.fillColor) {
            layers.push({
                id: `${key}-fill`,
                type: "fill",
                source: key,
                paint: {
                    "fill-color": colorValue("fill", style.fillColor),
                    "fill-opacity": fillOpacityValue(style.fillOpacity),
                },
            });
        }
        layers.push({
            id: `${key}-line`,
            type: "line",
            source: key,
            layout: { "line-join": "round", "line-cap": "round" },
            paint: {
                "line-color": colorValue("stroke", style.color),
                "line-width": strokeWidthValue(style.weight),
                "line-opacity": style.opacity != null ? style.opacity : 1,
            },
        });
    }
    return layers;
}

function initMap() {
    const sources = {
        // Base layers - OpenStreetMap and Esri World Imagery satellite, both
        // public tile services requiring no API key. Only one is shown at a
        // time; toggled via the "Satellite basemap" checkbox in the layer
        // panel, which is checked by default, so satellite is the initial
        // basemap. Tiles exist up to Leaflet zoom 19 and are overzoomed past it.
        osm: {
            type: "raster",
            tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
            tileSize: 256,
            maxzoom: 19,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        },
        satellite: {
            type: "raster",
            tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
            tileSize: 256,
            maxzoom: 19,
            attribution: "Tiles &copy; Esri",
        },
        extras: { type: "geojson", data: emptyCollection() },
        "debug-corners": { type: "geojson", data: emptyCollection() },
    };
    for (const key of Object.keys(FLOORPLAN_STYLES)) sources[key] = { type: "geojson", data: emptyCollection() };

    const map = new maplibregl.Map({
        container: "map",
        style: {
            version: 8,
            sources,
            layers: [
                { id: "background", type: "background", paint: { "background-color": "#dddddd" } },
                { id: "osm", type: "raster", source: "osm", layout: { visibility: "none" } },
                { id: "satellite", type: "raster", source: "satellite" },
                ...floorplanLayers(),
                {
                    id: "extras-fill", type: "fill", source: "extras",
                    paint: { "fill-color": EXTRA_COLOR, "fill-opacity": 0.2 },
                },
                {
                    id: "extras-line", type: "line", source: "extras",
                    layout: { "line-join": "round", "line-cap": "round" },
                    paint: { "line-color": EXTRA_COLOR, "line-width": 3 },
                },
                {
                    id: "extras-circle", type: "circle", source: "extras",
                    paint: {
                        "circle-radius": 10, "circle-color": EXTRA_COLOR, "circle-opacity": 0.2,
                        "circle-stroke-color": EXTRA_COLOR, "circle-stroke-width": 3,
                    },
                },
                {
                    id: "debug-corners-line", type: "line", source: "debug-corners",
                    paint: { "line-color": "#ff7a00", "line-width": 2, "line-dasharray": [3, 2] },
                },
            ],
        },
        center: DEFAULT_CENTER,
        zoom: OVERVIEW_ZOOM,
        maxZoom: ZOOM.MAX_DETAIL,
        // Leaflet maps are always north-up and flat.
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
    });
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");

    map.on("zoomend", updateZoomVisibility);
    map.on("click", showFeaturePopup);
    map.on("mousemove", (event) => {
        map.getCanvas().style.cursor = interactiveFeatureAt(event.point) ? "pointer" : "";
    });
    map.on("error", (event) => console.warn("Map error:", event.error || event));
    state.map = map;

    // Sources and layers are usable once the style has loaded; the "load"
    // event would also wait for every satellite tile to arrive.
    return new Promise((resolve) => {
        if (map.isStyleLoaded()) resolve();
        else map.once("style.load", resolve);
    });
}

/* ---------------------------------------------------------------------- */
/* Popups                                                                 */
/* ---------------------------------------------------------------------- */

// inventory-rack-fill (inventory.js) is listed so the cursor and hit order account for it;
// that module opens its own rack details.
const POPUP_LAYERS = ["departments-fill", "aisles-fill", "racks-fill", "extras-fill", "extras-line", "extras-circle", "inventory-rack-fill"];

function interactiveFeatureAt(point) {
    const layers = POPUP_LAYERS.filter((id) => state.map.getLayer(id));
    return state.map.queryRenderedFeatures(point, { layers })[0] || null;
}

function featurePopupContent(feature) {
    const props = feature.properties || {};
    switch (feature.layer.id) {
        case "departments-fill":
            return popupContent(props.label || props.name || props.poi_name || "Department", props.category ? humanize(props.category) : "");
        case "aisles-fill":
            return popupContent(props.label || props.name || "Aisle");
        case "racks-fill":
            return popupContent(props.label || props.name || "Rack", props.info || "");
        default: {
            const text = document.createElement("span");
            text.textContent = props.name || props.label || props.poi_name || "Map feature";
            return text;
        }
    }
}

function showFeaturePopup(event) {
    const feature = interactiveFeatureAt(event.point);
    if (!feature || feature.layer.id === "inventory-rack-fill") return;
    new maplibregl.Popup().setLngLat(event.lngLat).setDOMContent(featurePopupContent(feature)).addTo(state.map);
}

/* ---------------------------------------------------------------------- */
/* Labels and point markers                                               */
/* ---------------------------------------------------------------------- */

function addPolygonLabels(features, group, className, labelFor) {
    for (const feature of features || []) {
        const bounds = geometryBounds(feature.geometry);
        if (!boundsAreValid(bounds)) continue;
        group.addLayer(labelMarker(bounds.getCenter(), className, labelFor(feature.properties || {})));
    }
}

function buildMarkerLayer(feature) {
    const [lon, lat] = feature.geometry.coordinates;
    const props = feature.properties;
    const marker = iconMarker([lon, lat], props.category, iconFor(props.category, props.marker_type));
    marker.setPopup(new maplibregl.Popup().setDOMContent(popupContent(props.label || humanize(props.marker_type), humanize(props.category))));
    // Data min_zoom values are Leaflet zoom levels.
    return { layer: marker, minZoom: props.min_zoom != null ? props.min_zoom - 1 : ZOOM.STORE_LEVEL };
}

function buildGeoJsonPointLayer(feature) {
    const [lon, lat] = feature.geometry.coordinates;
    const props = feature.properties || {};
    const label = props.poi_name || props.name || props.label || "";
    if (props.icon_id || props.poi_name) {
        const category = props.profile === "STORE SERVICES" ? "store_service" : "basic_information";
        const markerType = normalizeIconId(props.icon_id || props.sub_category);
        const marker = iconMarker([lon, lat], category, iconFor(category, markerType));
        marker.setPopup(new maplibregl.Popup().setDOMContent(
            popupContent(label || humanize(markerType), props.profile ? humanize(props.profile.toLowerCase()) : "")));
        return { layer: marker, minZoom: ZOOM.STORE_LEVEL };
    }

    return {
        layer: labelMarker([lon, lat], "aisle-label", label),
        minZoom: ZOOM.DEPT_LABELS,
    };
}

function normalizeIconId(value) {
    return String(value || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/pick_up/g, "pickup")
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
}

/* ---------------------------------------------------------------------- */
/* Zoom-driven level of detail                                            */
/* ---------------------------------------------------------------------- */

function updateZoomVisibility() {
    if (!state.map) return;
    const zoom = state.map.getZoom();
    const deptVisible = document.getElementById("layer-department").checked;
    const aisleVisible = document.getElementById("layer-aisle").checked;
    const rackVisible = document.getElementById("layer-rack").checked;

    state.layers.deptLabels.setVisible(deptVisible && zoom >= ZOOM.DEPT_LABELS);
    state.layers.aisleLabels.setVisible(aisleVisible && zoom >= ZOOM.AISLE_LABELS);
    state.layers.rackLabels.setVisible(rackVisible && zoom >= ZOOM.RACK_DETAIL);

    // Aisle geometry itself becomes visible a level before its labels do,
    // and rack geometry a level before rack labels/info.
    setLayerVisible("departments", deptVisible);
    setLayerVisible("departmentLines", deptVisible);
    setLayerVisible("aisles", aisleVisible && zoom >= ZOOM.DEPT_LABELS_ALL);
    setLayerVisible("aisleLines", aisleVisible && zoom >= ZOOM.DEPT_LABELS_ALL);
    setLayerVisible("racks", rackVisible && zoom >= ZOOM.AISLE_LABELS);
    setLayerVisible("rackLines", rackVisible && zoom >= ZOOM.AISLE_LABELS);

    state.layers.markerGroup.setVisible(deptVisible, (marker) => zoom >= marker.minZoom);

    if (typeof updateExtrasVisibility === "function") updateExtrasVisibility();
}

function setLayerVisible(key, visible) {
    for (const id of [`${key}-fill`, `${key}-line`, key]) {
        if (state.map.getLayer(id)) state.map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    }
}

function isLayerVisible(key) {
    const id = state.map.getLayer(`${key}-fill`) ? `${key}-fill` : state.map.getLayer(`${key}-line`) ? `${key}-line` : key;
    return state.map.getLayoutProperty(id, "visibility") !== "none";
}

/* ---------------------------------------------------------------------- */
/* Loading store data                                                     */
/* ---------------------------------------------------------------------- */

async function fetchJSON(url, options) {
    const res = await fetch(url, options);
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`${res.status} ${res.statusText}: ${body}`);
    }
    return res.json();
}

function setFloorplanData(data) {
    state.layers.data = Object.fromEntries(FLOORPLAN_LAYER_KEYS.map((key) => [key, data[key] || emptyCollection()]));
    for (const key of Object.keys(FLOORPLAN_STYLES)) {
        state.map.getSource(key)?.setData(state.layers.data[key]);
    }
}

function clearFeatureLayers() {
    setFloorplanData({});
    state.layers.deptLabels.clearLayers();
    state.layers.aisleLabels.clearLayers();
    state.layers.rackLabels.clearLayers();
    state.layers.markerGroup.clearLayers();
    state.layers.markers = [];
    if (typeof clearInventoryLayer === "function") clearInventoryLayer();
}

function renderGeoJsonFloorplanData(data) {
    clearFeatureLayers();
    setFloorplanData(data);

    addPolygonLabels(data.departments.features, state.layers.deptLabels, "dept-label",
        (props) => props.label || props.name || props.poi_name || "Department");
    addPolygonLabels(data.aisles.features, state.layers.aisleLabels, "aisle-label",
        (props) => props.label || props.name || "Aisle");
    addPolygonLabels(data.racks.features, state.layers.rackLabels, "rack-label",
        (props) => props.info || props.label || props.name || "Rack");

    for (const feature of data.departmentPoints.features || []) {
        const point = buildGeoJsonPointLayer(feature);
        if (feature.properties?.poi_name || feature.properties?.icon_id) {
            point.layer.minZoom = point.minZoom;
            state.layers.markers.push(point);
            state.layers.markerGroup.addLayer(point.layer);
        } else {
            state.layers.deptLabels.addLayer(point.layer);
        }
    }

    for (const feature of data.aislePoints.features || []) {
        const point = buildGeoJsonPointLayer(feature);
        state.layers.aisleLabels.addLayer(point.layer);
    }
}

/* ---------------------------------------------------------------------- */
/* Layer panel checkboxes                                                 */
/* ---------------------------------------------------------------------- */

function wireLayerControls() {
    document.getElementById("layer-satellite").addEventListener("change", (e) => {
        state.map.setLayoutProperty("osm", "visibility", e.target.checked ? "none" : "visible");
        state.map.setLayoutProperty("satellite", "visibility", e.target.checked ? "visible" : "none");
    });

    for (const id of ["layer-department", "layer-aisle", "layer-rack"]) {
        document.getElementById(id).addEventListener("change", updateZoomVisibility);
    }
}

/* ---------------------------------------------------------------------- */
/* Boot                                                                    */
/* ---------------------------------------------------------------------- */

document.addEventListener("DOMContentLoaded", async () => {
    wireCollapsiblePanels();
    try {
        await initMap();
    } catch (err) {
        console.error("Failed to start the map:", err);
        return;
    }
    wireLayerControls();
    try {
        await loadStores();
    } catch (err) {
        console.error("Failed to load stores:", err);
    }
});
