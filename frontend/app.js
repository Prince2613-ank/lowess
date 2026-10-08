/* ==========================================================================
 * Lowe's Interactive Store Map - frontend application logic.
 *
 * Talks to the FastAPI backend for the store directory and renders the raw
 * Lowes_*.geojson floor plan on a Leaflet map over OpenStreetMap tiles.
 * ========================================================================== */

const DEFAULT_CENTER = [39.5, -98.35];
const DEFAULT_ZOOM = 18;

// Zoom thresholds driving progressive level-of-detail (see spec).
const ZOOM = {
    STORE_LEVEL: 18,
    DEPT_LABELS: 18,
    DEPT_LABELS_ALL: 20,
    AISLE_LABELS: 18,
    RACK_DETAIL: 22,
    MAX_DETAIL: 23,
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
/* App state                                                              */
/* ---------------------------------------------------------------------- */

const state = {
    map: null,
    stores: [],
    currentStoreId: null,
    currentStore: null,

    layers: {
        departments: null,
        deptLabels: null,
        aisles: null,
        aisleLabels: null,
        racks: null,
        departmentLines: null,
        aisleLines: null,
        rackLines: null,
        rackLabels: null,
        markers: null,   // array of {layer, minZoom}
        storePin: null,
        osmTile: null,
        satelliteTile: null,
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
                window.setTimeout(() => state.map.invalidateSize(), 50);
            }
        });
    });
}

/* ---------------------------------------------------------------------- */
/* Map bootstrap                                                          */
/* ---------------------------------------------------------------------- */

function initMap() {
    const map = L.map("map", { zoomControl: true }).setView(DEFAULT_CENTER, 4);

    // Base layers - OpenStreetMap and Esri World Imagery satellite, both
    // public tile services requiring no API key. Only one is shown at a
    // time; toggled via the "Satellite basemap" checkbox in the layer panel,
    // which is checked by default, so satellite is the initial basemap.
    state.layers.osmTile = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 23,
        maxNativeZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    });

    state.layers.satelliteTile = L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        {
            maxZoom: 23,
            maxNativeZoom: 19,
            attribution: "Tiles &copy; Esri",
        }
    ).addTo(map);

    state.layers.departments = L.geoJSON(null, { style: departmentStyle, onEachFeature: onEachDepartment }).addTo(map);
    state.layers.deptLabels = L.layerGroup().addTo(map);
    state.layers.aisles = L.geoJSON(null, { style: aisleStyle, onEachFeature: onEachAisle }).addTo(map);
    state.layers.aisleLabels = L.layerGroup().addTo(map);
    state.layers.racks = L.geoJSON(null, { style: rackStyle, onEachFeature: onEachRack }).addTo(map);
    state.layers.departmentLines = L.geoJSON(null, { style: departmentLineStyle }).addTo(map);
    state.layers.aisleLines = L.geoJSON(null, { style: aisleLineStyle }).addTo(map);
    state.layers.rackLines = L.geoJSON(null, { style: rackLineStyle }).addTo(map);
    state.layers.rackLabels = L.layerGroup().addTo(map);
    state.layers.markers = [];
    state.layers.markerGroup = L.layerGroup().addTo(map);

    map.on("zoomend", updateZoomVisibility);
    state.map = map;
}

/* ---------------------------------------------------------------------- */
/* Feature styling                                                        */
/* ---------------------------------------------------------------------- */

function departmentStyle(feature) {
    return geoJsonStyle({ color: "#96A3BD", weight: 1, fillColor: "#D9E2F6", fillOpacity: 0.75 }, feature);
}

function aisleStyle(feature) {
    return geoJsonStyle({ color: "#BBBBBB", weight: 1, fillColor: "#DCDEE2", fillOpacity: 0.7 }, feature);
}

function rackStyle(feature) {
    return geoJsonStyle({ color: "#9ca3af", weight: 1, fillColor: "#DCDEE2", fillOpacity: 0.8 }, feature);
}

function departmentLineStyle(feature) {
    return geoJsonStyle({ color: "#6b7280", weight: 1.5, opacity: 0.95 }, feature);
}

function aisleLineStyle(feature) {
    return geoJsonStyle({ color: "#8b949e", weight: 1, opacity: 0.9 }, feature);
}

function rackLineStyle(feature) {
    return geoJsonStyle({ color: "#4b5563", weight: 0.8, opacity: 0.85 }, feature);
}

function geoJsonStyle(defaults, feature = null) {
    const props = feature?.properties || {};
    const fillOpacity = props.opacity != null ? Number(props.opacity) : defaults.fillOpacity;
    return {
        color: props.stroke || defaults.color,
        weight: Number(props["stroke-width"]) || defaults.weight,
        opacity: defaults.opacity != null ? defaults.opacity : 1,
        fillColor: props.fill || defaults.fillColor,
        fillOpacity: Number.isFinite(fillOpacity) ? fillOpacity : defaults.fillOpacity,
    };
}

function onEachDepartment(feature, layer) {
    const name = feature.properties.label || feature.properties.name || feature.properties.poi_name || "Department";
    layer.bindPopup(`<b>${name}</b>${feature.properties.category ? humanize(feature.properties.category) : ""}`);
    if (!layer.getBounds().isValid()) return;
    const center = layer.getBounds().getCenter();
    const label = L.marker(center, {
        interactive: false,
        icon: L.divIcon({ className: "dept-label", html: name, iconSize: null }),
    });
    label._minZoom = ZOOM.DEPT_LABELS;
    state.layers.deptLabels.addLayer(label);
}

function onEachAisle(feature, layer) {
    const name = feature.properties.label || feature.properties.name || "Aisle";
    layer.bindPopup(`<b>${name}</b>`);
    if (!layer.getBounds().isValid()) return;
    const center = layer.getBounds().getCenter();
    const label = L.marker(center, {
        interactive: false,
        icon: L.divIcon({ className: "aisle-label", html: name, iconSize: null }),
    });
    label._minZoom = ZOOM.AISLE_LABELS;
    state.layers.aisleLabels.addLayer(label);
}

function onEachRack(feature, layer) {
    const name = feature.properties.label || feature.properties.name || "Rack";
    const info = feature.properties.info || "";
    layer.bindPopup(`<b>${name}</b>${info}`);
    if (!layer.getBounds().isValid()) return;
    const center = layer.getBounds().getCenter();
    const label = L.marker(center, {
        interactive: false,
        icon: L.divIcon({ className: "rack-label", html: info || name, iconSize: null }),
    });
    label._minZoom = ZOOM.RACK_DETAIL;
    state.layers.rackLabels.addLayer(label);
}

function buildMarkerLayer(feature) {
    const [lon, lat] = feature.geometry.coordinates;
    const props = feature.properties;
    const emoji = iconFor(props.category, props.marker_type);
    const marker = L.marker([lat, lon], {
        icon: L.divIcon({
            className: "",
            html: `<div class="marker-icon ${props.category}">${emoji}</div>`,
            iconSize: [26, 26],
            iconAnchor: [13, 13],
        }),
    });
    marker.bindPopup(`<b>${props.label || humanize(props.marker_type)}</b>${humanize(props.category)}`);
    return { layer: marker, minZoom: props.min_zoom || ZOOM.STORE_LEVEL };
}

function buildGeoJsonPointLayer(feature) {
    const [lon, lat] = feature.geometry.coordinates;
    const props = feature.properties || {};
    const label = props.poi_name || props.name || props.label || "";
    if (props.icon_id || props.poi_name) {
        const category = props.profile === "STORE SERVICES" ? "store_service" : "basic_information";
        const markerType = normalizeIconId(props.icon_id || props.sub_category);
        const emoji = iconFor(category, markerType);
        const marker = L.marker([lat, lon], {
            icon: L.divIcon({
                className: "",
                html: `<div class="marker-icon ${category}">${emoji}</div>`,
                iconSize: [26, 26],
                iconAnchor: [13, 13],
            }),
        });
        marker.bindPopup(`<b>${label || humanize(markerType)}</b>${props.profile ? humanize(props.profile.toLowerCase()) : ""}`);
        return { layer: marker, minZoom: ZOOM.STORE_LEVEL };
    }

    return {
        layer: L.marker([lat, lon], {
            interactive: false,
            icon: L.divIcon({ className: "aisle-label", html: label, iconSize: null }),
        }),
        minZoom: ZOOM.DEPT_LABELS,
    };
}

function normalizeIconId(value) {
    return String(value || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
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
    const map = state.map;
    const deptVisible = document.getElementById("layer-department").checked;
    const aisleVisible = document.getElementById("layer-aisle").checked;
    const rackVisible = document.getElementById("layer-rack").checked;

    setLayerGroupVisible(state.layers.deptLabels, map, deptVisible && zoom >= ZOOM.DEPT_LABELS);
    setLayerGroupVisible(state.layers.aisleLabels, map, aisleVisible && zoom >= ZOOM.AISLE_LABELS);
    setLayerGroupVisible(state.layers.rackLabels, map, rackVisible && zoom >= ZOOM.RACK_DETAIL);

    // Aisle geometry itself becomes visible a level before its labels do,
    // and rack geometry a level before rack labels/info.
    setLayerVisible(state.layers.departments, map, deptVisible);
    setLayerVisible(state.layers.departmentLines, map, deptVisible);
    setLayerVisible(state.layers.aisles, map, aisleVisible && zoom >= ZOOM.DEPT_LABELS_ALL);
    setLayerVisible(state.layers.aisleLines, map, aisleVisible && zoom >= ZOOM.DEPT_LABELS_ALL);
    setLayerVisible(state.layers.racks, map, rackVisible && zoom >= ZOOM.AISLE_LABELS);
    setLayerVisible(state.layers.rackLines, map, rackVisible && zoom >= ZOOM.AISLE_LABELS);

    setLayerGroupVisible(state.layers.markerGroup, map, deptVisible);
    for (const { layer, minZoom } of state.layers.markers) {
        setLayerVisible(layer, map, deptVisible && zoom >= minZoom);
    }
}

function setLayerGroupVisible(group, map, visible) {
    if (visible && !map.hasLayer(group)) map.addLayer(group);
    if (!visible && map.hasLayer(group)) map.removeLayer(group);
}

function setLayerVisible(layer, map, visible) {
    if (!layer) return;
    if (visible && !map.hasLayer(layer)) map.addLayer(layer);
    if (!visible && map.hasLayer(layer)) map.removeLayer(layer);
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

function clearFeatureLayers() {
    state.layers.departments.clearLayers();
    state.layers.deptLabels.clearLayers();
    state.layers.aisles.clearLayers();
    state.layers.aisleLabels.clearLayers();
    state.layers.racks.clearLayers();
    state.layers.departmentLines.clearLayers();
    state.layers.aisleLines.clearLayers();
    state.layers.rackLines.clearLayers();
    state.layers.rackLabels.clearLayers();
    state.layers.markerGroup.clearLayers();
    state.layers.markers = [];
}

function renderGeoJsonFloorplanData(data) {
    state.layers.departments.clearLayers();
    state.layers.departmentLines.clearLayers();
    state.layers.aisles.clearLayers();
    state.layers.aisleLines.clearLayers();
    state.layers.racks.clearLayers();
    state.layers.rackLines.clearLayers();
    state.layers.deptLabels.clearLayers();
    state.layers.aisleLabels.clearLayers();
    state.layers.markerGroup.clearLayers();
    state.layers.markers = [];

    state.layers.departments.addData(data.departments);
    state.layers.departmentLines.addData(data.departmentLines);
    state.layers.aisles.addData(data.aisles);
    state.layers.aisleLines.addData(data.aisleLines);
    state.layers.racks.addData(data.racks);
    state.layers.rackLines.addData(data.rackLines);

    for (const feature of data.departmentPoints.features || []) {
        const point = buildGeoJsonPointLayer(feature);
        if (feature.properties?.poi_name || feature.properties?.icon_id) {
            state.layers.markers.push(point);
            state.layers.markerGroup.addLayer(point.layer);
        } else {
            point.layer._minZoom = ZOOM.DEPT_LABELS;
            state.layers.deptLabels.addLayer(point.layer);
        }
    }

    for (const feature of data.aislePoints.features || []) {
        const point = buildGeoJsonPointLayer(feature);
        point.layer._minZoom = ZOOM.AISLE_LABELS;
        state.layers.aisleLabels.addLayer(point.layer);
    }
}

/* ---------------------------------------------------------------------- */
/* Layer panel checkboxes                                                 */
/* ---------------------------------------------------------------------- */

function wireLayerControls() {
    document.getElementById("layer-satellite").addEventListener("change", (e) => {
        setLayerVisible(state.layers.osmTile, state.map, !e.target.checked);
        setLayerVisible(state.layers.satelliteTile, state.map, e.target.checked);
    });

    for (const id of ["layer-department", "layer-aisle", "layer-rack"]) {
        document.getElementById(id).addEventListener("change", updateZoomVisibility);
    }
}

/* ---------------------------------------------------------------------- */
/* Boot                                                                    */
/* ---------------------------------------------------------------------- */

document.addEventListener("DOMContentLoaded", async () => {
    initMap();
    wireLayerControls();
    wireCollapsiblePanels();
    try {
        await loadStores();
    } catch (err) {
        console.error("Failed to load stores:", err);
    }
});
