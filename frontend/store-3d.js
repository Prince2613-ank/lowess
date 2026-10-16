/* ==========================================================================
 * 2.5D / 3D store view.
 *
 * A "3D" button under the zoom controls tilts the map and turns the store
 * into extruded geometry:
 *   - the sales floor (department areas) as a raised floor slab;
 *   - fixtures (aisle polygons) at counter height;
 *   - every rack as a glass shell 2.4 m tall, filled to its stock level in
 *     its occupancy colour (green / yellow / red / grey, as the legend);
 *   - racks on the shown carts' routes capped in the cart's colour;
 *   - the selected cart's route animated: dashes flowing in walking
 *     direction and a cart moving along it (still when the viewer prefers
 *     reduced motion).
 * Right-drag (or two fingers) rotates and tilts while 3D is on. Turning it off
 * returns to the flat, north-up map. Built on the store map's own sources
 * (floor plan, inventory, picking), so it always matches the 2D view.
 * ========================================================================== */

const STORE_3D = {
    PITCH: 55,
    BEARING: -20,
    FLOOR: 0.08,          // m, sales-floor slab
    FIXTURE: 1.1,         // m, aisle fixtures
    RACK: 2.4,            // m, rack shell
    CAP: 0.4,             // m, route cap on top of a rack
    STOCK_MIN: 0.25,      // m, stock block of an almost empty rack
    CART_SPEED: 6,        // m per second of animation (a compressed walk)
    LOOP_MIN_S: 8,
    LOOP_MAX_S: 40,
};
const STORE_3D_LAYERS = ["store3d-floor", "store3d-fixtures", "store3d-stock", "store3d-shell", "store3d-targets", "store3d-route-flow", "store3d-cart-halo", "store3d-cart"];
const STORE_3D_CART_SOURCE = "store3d-cart";
// Flowing dashes: each step shifts the dash pattern a little along the line.
const STORE_3D_DASHES = [
    [0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0],
    [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5],
];

const store3d = {
    enabled: false,
    layersReady: false,
    button: null,
    frame: null,
    route: null,          // { key, points: [[lng, lat]], cumulative: [m], length }
    started: 0,
    reducedMotion: window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false,
};

const store3dActive = () => store3d.enabled;

/* Layers ----------------------------------------------------------------- */

function ensureStore3dLayers() {
    const map = state.map;
    if (store3d.layersReady || !map || !map.getSource(INVENTORY_SOURCE)) return store3d.layersReady;
    const selected = ["boolean", ["feature-state", "selected"], false];
    const hover = ["boolean", ["feature-state", "hover"], false];
    const visible = ["==", ["get", "visible"], true];
    // Under the picking route lines, so routes stay readable on the floor.
    const before = map.getLayer("picking-target-fill") ? "picking-target-fill" : map.getLayer("extras-fill") ? "extras-fill" : undefined;
    const extrusion = (id, source, paint, extra = {}) => map.addLayer({ id, type: "fill-extrusion", source, layout: { visibility: "none" }, paint, ...extra }, before);

    if (map.getSource("departments")) {
        extrusion("store3d-floor", "departments", {
            "fill-extrusion-color": "#e6ecf7", "fill-extrusion-height": STORE_3D.FLOOR, "fill-extrusion-base": 0, "fill-extrusion-opacity": 0.94,
        });
    }
    if (map.getSource("aisles")) {
        extrusion("store3d-fixtures", "aisles", {
            "fill-extrusion-color": "#9aa8bc", "fill-extrusion-height": STORE_3D.FIXTURE, "fill-extrusion-base": STORE_3D.FLOOR, "fill-extrusion-opacity": 0.9,
        });
    }
    // Stock: a block whose height is the rack's occupancy, in the occupancy colour.
    extrusion("store3d-stock", INVENTORY_SOURCE, {
        "fill-extrusion-color": ["case", selected, "#2563eb", bandColorExpression()],
        "fill-extrusion-height": ["+", STORE_3D.FLOOR + STORE_3D.STOCK_MIN,
            ["*", (STORE_3D.RACK - STORE_3D.FLOOR - STORE_3D.STOCK_MIN) / 100, ["min", 100, ["max", 0, ["to-number", ["get", "occupancy"], 0]]]]],
        "fill-extrusion-base": STORE_3D.FLOOR,
        "fill-extrusion-opacity": 0.95,
    }, { filter: visible });
    // Rack frame: a light glass shell at full rack height around the stock.
    extrusion("store3d-shell", INVENTORY_SOURCE, {
        "fill-extrusion-color": ["case", selected, "#93c5fd", hover, "#dbeafe", "#f8fafc"],
        "fill-extrusion-height": STORE_3D.RACK,
        "fill-extrusion-base": STORE_3D.FLOOR,
        "fill-extrusion-opacity": 0.32,
    }, { filter: visible });
    if (map.getSource(PICKING_TARGET_SOURCE)) {
        const stage = ["get", "stage"];
        extrusion("store3d-targets", PICKING_TARGET_SOURCE, {
            "fill-extrusion-color": ["match", stage, "done", "#94a3b8", ["get", "color"]],
            "fill-extrusion-height": STORE_3D.RACK + STORE_3D.CAP,
            "fill-extrusion-base": STORE_3D.RACK + 0.02,
            "fill-extrusion-opacity": 0.95,
        });
    }
    if (map.getSource(PICKING_ROUTE_SOURCE)) {
        map.addLayer({
            id: "store3d-route-flow", type: "line", source: PICKING_ROUTE_SOURCE, filter: ["==", ["get", "selected"], true],
            layout: { visibility: "none", "line-join": "round", "line-cap": "butt" },
            paint: { "line-color": "#ffffff", "line-width": 2.5, "line-opacity": 0.95, "line-dasharray": STORE_3D_DASHES[0] },
        }, map.getLayer("picking-route-arrows") ? "picking-route-arrows" : before);
    }
    map.addSource(STORE_3D_CART_SOURCE, { type: "geojson", data: emptyCollection() });
    map.addLayer({ id: "store3d-cart-halo", type: "circle", source: STORE_3D_CART_SOURCE, layout: { visibility: "none" },
        paint: { "circle-radius": 13, "circle-color": ["get", "color"], "circle-opacity": 0.25, "circle-pitch-alignment": "map" } });
    map.addLayer({ id: "store3d-cart", type: "circle", source: STORE_3D_CART_SOURCE, layout: { visibility: "none" },
        paint: { "circle-radius": 6.5, "circle-color": ["get", "color"], "circle-stroke-color": "#ffffff", "circle-stroke-width": 2.5, "circle-pitch-alignment": "map" } });
    for (const id of STORE_3D_LAYERS) if (map.getLayer(id)) map.setLayerZoomRange(id, ZOOM.STORE_OVERLAYS, 24);

    // In 3D the extruded rack is what is under the pointer.
    map.on("click", "store3d-shell", (event) => {
        const id = event.features?.[0]?.properties?.rack_id;
        if (id) selectRack(id, { zoom: false, scroll: true });
    });
    map.on("mousemove", "store3d-shell", onRackHover);
    map.on("mouseleave", "store3d-shell", clearRackHover);
    store3d.layersReady = true;
    return true;
}

function applyStore3dVisibility() {
    const map = state.map;
    if (!map || !store3d.layersReady) return;
    for (const id of STORE_3D_LAYERS) {
        if (!map.getLayer(id)) continue;
        // Route layers follow the picking tab; the store geometry is always shown in 3D.
        const routeLayer = id.startsWith("store3d-route") || id.startsWith("store3d-cart") || id === "store3d-targets";
        const pickingShown = map.getLayer("picking-route-line") && map.getLayoutProperty("picking-route-line", "visibility") !== "none";
        map.setLayoutProperty(id, "visibility", store3d.enabled && (!routeLayer || pickingShown) ? "visible" : "none");
    }
}

/* Route animation -------------------------------------------------------- */

function metresBetween([lng1, lat1], [lng2, lat2]) {
    const kx = 111320 * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
    return Math.hypot((lng2 - lng1) * kx, (lat2 - lat1) * 110574);
}

// The selected cart's route as one path (legs in walking order).
function selectedRoutePath() {
    if (typeof selectedCart !== "function" || !picking.store || picking.tab !== "picking") return null;
    const cart = selectedCart();
    const plan = cart && planFor(cart.cart_id);
    if (!plan || !plan.coords?.length) return null;
    const key = plan;
    if (store3d.route?.key === key) return store3d.route;
    const points = [];
    for (const line of plan.coords) {
        for (const point of line) {
            const last = points[points.length - 1];
            if (!last || last[0] !== point[0] || last[1] !== point[1]) points.push(point);
        }
    }
    const cumulative = [0];
    for (let i = 1; i < points.length; i += 1) cumulative.push(cumulative[i - 1] + metresBetween(points[i - 1], points[i]));
    store3d.route = { key, points, cumulative, length: cumulative[cumulative.length - 1], color: cart.color };
    store3d.started = performance.now();
    return store3d.route;
}

function pointAlong(route, distance) {
    const { points, cumulative } = route;
    let i = 1;
    while (i < cumulative.length - 1 && cumulative[i] < distance) i += 1;
    const span = cumulative[i] - cumulative[i - 1] || 1;
    const t = Math.min(1, Math.max(0, (distance - cumulative[i - 1]) / span));
    const [a, b] = [points[i - 1], points[i]];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function animateStore3d(now) {
    store3d.frame = null;
    const map = state.map;
    if (!store3d.enabled || !map) return;
    const route = selectedRoutePath();
    const source = map.getSource(STORE_3D_CART_SOURCE);
    if (!route || route.length < 1 || !source) {
        source?.setData(emptyCollection());
    } else {
        const loop = Math.min(STORE_3D.LOOP_MAX_S, Math.max(STORE_3D.LOOP_MIN_S, route.length / STORE_3D.CART_SPEED)) * 1000;
        const progress = store3d.reducedMotion ? 0 : ((now - store3d.started) % loop) / loop;
        source.setData({ type: "Feature", properties: { color: route.color }, geometry: { type: "Point", coordinates: pointAlong(route, progress * route.length) } });
        if (!store3d.reducedMotion && map.getLayer("store3d-route-flow")) {
            const step = Math.floor(now / 70) % STORE_3D_DASHES.length;
            if (step !== store3d.dashStep) {
                store3d.dashStep = step;
                map.setPaintProperty("store3d-route-flow", "line-dasharray", STORE_3D_DASHES[step]);
            }
        }
    }
    if (!store3d.reducedMotion) store3d.frame = requestAnimationFrame(animateStore3d);
}

function restartStore3dAnimation() {
    if (store3d.frame) cancelAnimationFrame(store3d.frame);
    store3d.frame = null;
    if (store3d.enabled) store3d.frame = requestAnimationFrame(animateStore3d);
}

/* Called by the picking map after it redraws (routes, tab or cart changed). */
function onPickingMapDrawn() {
    if (!store3d.enabled) return;
    applyStore3dVisibility();
    restartStore3dAnimation();
}

/* Switching ---------------------------------------------------------------- */

function setStore3d(enabled) {
    const map = state.map;
    if (!map) return;
    store3d.enabled = enabled;
    if (enabled) ensureStore3dLayers();
    store3d.button?.setAttribute("aria-pressed", String(enabled));
    store3d.button?.classList.toggle("active", enabled);
    map.getContainer().classList.toggle("store-3d", enabled);
    if (enabled) {
        map.dragRotate.enable();
        map.touchZoomRotate.enableRotation();
        map.touchPitch.enable();
        map.keyboard.enableRotation();
        map.setLight({ anchor: "viewport", color: "#ffffff", intensity: 0.4, position: [1.2, 210, 35] });
        // A light sky above the horizon instead of the plain map background.
        if (typeof map.setSky === "function") map.setSky({ "sky-color": "#bcd7f2", "horizon-color": "#eaf2fb", "sky-horizon-blend": 0.7, "horizon-fog-blend": 0.6, "fog-color": "#eaf2fb", "fog-ground-blend": 0.9 });
        map.easeTo({ pitch: STORE_3D.PITCH, bearing: map.getBearing() || STORE_3D.BEARING, zoom: Math.max(map.getZoom(), ZOOM.STORE_LEVEL + 0.5), duration: 900 });
    } else {
        map.dragRotate.disable();
        map.touchZoomRotate.disableRotation();
        map.touchPitch.disable();
        map.keyboard.disableRotation();
        map.easeTo({ pitch: 0, bearing: 0, duration: 700 });
        state.map.getSource(STORE_3D_CART_SOURCE)?.setData(emptyCollection());
    }
    applyStore3dVisibility();
    if (typeof renderPickingMap === "function") renderPickingMap();  // flat route highlights give way to the 3D caps
    restartStore3dAnimation();
}

class Store3dControl {
    onAdd(map) {
        this.container = document.createElement("div");
        this.container.className = "maplibregl-ctrl maplibregl-ctrl-group store-3d-control";
        const button = document.createElement("button");
        button.type = "button";
        button.className = "store-3d-toggle";
        button.textContent = "3D";
        button.title = "3D store view (right-drag to rotate and tilt)";
        button.setAttribute("aria-label", "3D store view");
        button.setAttribute("aria-pressed", "false");
        button.addEventListener("click", () => setStore3d(!store3d.enabled));
        store3d.button = button;
        this.container.append(button);
        return this.container;
    }
    onRemove() { this.container.remove(); }
}

/* Hooks called by the store map (guarded there). */

function onStore3dReady() {
    if (!store3d.enabled) return;
    ensureStore3dLayers();
    applyStore3dVisibility();
    restartStore3dAnimation();
}

document.addEventListener("DOMContentLoaded", () => {
    const wait = () => {
        if (!state.map) return window.setTimeout(wait, 100);
        state.map.addControl(new Store3dControl(), "top-left");
    };
    wait();
});
