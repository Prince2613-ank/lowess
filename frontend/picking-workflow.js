/* ==========================================================================
 * Online Order Picking & multi-cart routes: map layers and the "Order
 * Picking" tab of the operations sidebar.
 *
 * Builds on OrderManagement (orders/carts), IndoorRouting (walking network)
 * and the Rack Inventory module (inventory.model for stock, inventory.racks
 * for aligned rack geometry). Hooks used by the existing app:
 *   onPickingInventoryReady(store, alignedData, sourceData) - inventory.js
 *   clearPickingLayers()                                     - app.js
 * ========================================================================== */

const PICKING_ROUTE_SOURCE = "picking-routes";
const PICKING_TARGET_SOURCE = "picking-target";
const PICKING_LAYERS = ["picking-target-fill", "picking-target-halo", "picking-target-outline", "picking-route-casing", "picking-route-line", "picking-route-arrows"];
// Online orders arrive on their own while a store is open, as from the web shop:
// one every 2-5 minutes, at random.
const ORDER_FEED_MINUTES = [2, 5];
const NEW_ORDER_HIGHLIGHT_MS = 60000;

const picking = {
    storeId: null,
    store: null,          // OrderManagement.PickingStore
    network: null,        // IndoorRouting.Network
    generation: 0,
    loading: false,
    error: "",
    toMap: null,
    alignVersion: 0,
    layersReady: false,
    markers: [],
    plans: new Map(),     // cart_id -> { signature, plan }
    selectedOrders: new Set(),
    detailsOrderId: null,
    filters: { query: "", status: "", priority: "" },
    tab: "inventory",
    message: { text: "", error: false },
    subscribedModel: null,
    unsubscribe: null,
    newOrders: new Set(),  // order ids received in the last minute (highlighted)
    feedTimer: null,
    feedStopped: false,
    resetDone: new Set(),  // stores reset by ?reset=1 on this page load
};

const pk$ = (id) => document.getElementById(id);

/* ---------------------------------------------------------------------- */
/* Alignment: route geometry follows the map exactly like the floor plan   */
/* ---------------------------------------------------------------------- */

// Same transform alignSourceMap() (directory.js) applies to the floor plan,
// computed from the store's source map so routes and racks stay registered.
function makePickingAligner(store, sourceData) {
    const context = debugContext(sourceData, store);
    if (context) return ([lon, lat]) => projectSourcePoint(lon, lat, context);
    if (!Number.isFinite(store.latitude) || !Number.isFinite(store.longitude)) return (point) => point;
    const layers = collectLayers(sourceData);
    if (!layers.length || layers.some(([, fc]) => fc.metadata?.source_type)) return (point) => point;
    const points = coordinatePoints(sourceData);
    if (!points.length) return (point) => point;
    const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
    const dx = store.longitude - (Math.min(...xs) + Math.max(...xs)) / 2;
    const dy = store.latitude - (Math.min(...ys) + Math.max(...ys)) / 2;
    return ([lon, lat]) => [lon + dx, lat + dy];
}

function lineMeters(coords) {
    let total = 0;
    for (let i = 1; i < coords.length; i += 1) {
        const [x0, y0] = coords[i - 1], [x1, y1] = coords[i];
        const kx = 111320 * Math.cos(((y0 + y1) / 2) * Math.PI / 180);
        total += Math.hypot((x1 - x0) * kx, (y1 - y0) * 110574);
    }
    return total;
}

/* ---------------------------------------------------------------------- */
/* Route planning per cart                                                 */
/* ---------------------------------------------------------------------- */

// Pack & Dispatch: where carts start and finish, and orders go to the driver.
function dispatchCell() {
    return picking.network?.dispatch?.cell ?? null;
}

function cartSignature(cart) {
    const picked = cart.orders.flatMap((id) => (picking.store.order(id)?.lines || []).map((line) => (picking.store.pick(id, line.line_no) ? 1 : 0)));
    return [cart.orders.join(","), picked.join(""), cart.location || "", picking.alignVersion].join("|");
}

function planFor(cartId, { force = false } = {}) {
    const store = picking.store, network = picking.network;
    const cart = store?.cart(cartId);
    if (!cart || !network || !picking.toMap) return null;
    const signature = cartSignature(cart);
    const cached = picking.plans.get(cartId);
    if (cached && cached.signature === signature && !force) return cached.plan;

    const stops = store.stops(cartId);
    const remaining = stops.filter((stop) => !stop.done);
    const dropOff = dispatchCell();
    const start = cart.location != null && network.rackAccess[cart.location] != null ? network.rackAccess[cart.location] : dropOff;
    const routable = [], noAccess = [];
    for (const stop of remaining) {
        const cell = network.rackAccess[stop.rack_id];
        if (cell == null) noAccess.push(stop.rack_id); else routable.push({ key: stop.rack_id, cell });
    }
    let plan;
    if (!cart.orders.length) {
        plan = { order: [], legs: [], coords: [], distance: 0, method: "none", unreachable: [], warnings: [], stops };
    } else {
        const route = IndoorRouting.planRoute(network, { start, end: dropOff, stops: routable });
        const coords = network.alignLanes(route.legs).filter((corners) => corners && corners.length > 1).map((corners) => network.cornersToMap(corners, picking.toMap));
        const warnings = route.warnings.slice();
        if (dropOff == null) warnings.push("No Pack & Dispatch point on this store's walking network; the route ends at the last stop.");
        if (noAccess.length) warnings.push(`No walkable access found next to ${noAccess.join(", ")} - flagged for review, not routed.`);
        if (route.unreachable.length) warnings.push(`${route.unreachable.join(", ")} cannot be reached on the walking network from the cart's position - flagged for review.`);
        plan = {
            ...route,
            coords,
            distance: coords.reduce((sum, line) => sum + lineMeters(line), 0),
            unreachable: [...noAccess, ...route.unreachable],
            warnings,
            stops,
            start,
            startLabel: cart.location ? `Last pick at ${cart.location}` : network.dispatch ? `Staging at ${network.dispatch.name}` : "Unknown",
        };
    }
    picking.plans.set(cartId, { signature, plan });
    return plan;
}

const titleCase = (text) => String(text || "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

/* ---------------------------------------------------------------------- */
/* Map layers                                                              */
/* ---------------------------------------------------------------------- */

function arrowImage() {
    const size = 32, canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    const chevron = () => { ctx.beginPath(); ctx.moveTo(11, 8); ctx.lineTo(21, 16); ctx.lineTo(11, 24); ctx.stroke(); };
    ctx.strokeStyle = "rgba(15, 23, 42, 0.55)"; ctx.lineWidth = 7; chevron();
    ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 4; chevron();
    return ctx.getImageData(0, 0, size, size);
}

function ensurePickingLayers() {
    if (picking.layersReady || !state.map) return;
    const map = state.map;
    const before = map.getLayer("extras-fill") ? "extras-fill" : undefined;
    map.addSource(PICKING_TARGET_SOURCE, { type: "geojson", data: emptyCollection() });
    map.addSource(PICKING_ROUTE_SOURCE, { type: "geojson", data: emptyCollection() });
    if (!map.hasImage("picking-arrow")) map.addImage("picking-arrow", arrowImage(), { pixelRatio: 2 });
    const selected = ["boolean", ["get", "selected"], false];
    // Every rack on the route: the next stop strongest, remaining stops lighter, picked ones faint grey.
    const stage = ["get", "stage"];
    // A white halo under a cart-coloured outline keeps each rack readable over the occupancy colours.
    const width = (next, pending, done) => ["interpolate", ["linear"], ["zoom"], 17, ["match", stage, "next", next * 0.6, "pending", pending * 0.6, done * 0.6],
        20, ["match", stage, "next", next, "pending", pending, done]];
    map.addLayer({ id: "picking-target-fill", type: "fill", source: PICKING_TARGET_SOURCE, paint: {
        "fill-color": ["match", stage, "done", "#94a3b8", ["get", "color"]],
        "fill-opacity": ["match", stage, "next", 0.75, "pending", 0.55, 0.3],
    } }, before);
    map.addLayer({ id: "picking-target-halo", type: "line", source: PICKING_TARGET_SOURCE, paint: {
        "line-color": "#ffffff", "line-width": width(9, 7, 4), "line-opacity": ["match", stage, "done", 0.6, 0.95],
    } }, before);
    map.addLayer({ id: "picking-target-outline", type: "line", source: PICKING_TARGET_SOURCE, paint: {
        "line-color": ["match", stage, "done", "#64748b", ["get", "color"]],
        "line-width": width(4.5, 3, 1.5),
    } }, before);
    map.addLayer({
        id: "picking-route-casing", type: "line", source: PICKING_ROUTE_SOURCE,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#ffffff", "line-width": ["case", selected, 9, 6], "line-opacity": ["case", selected, 0.95, 0.55] },
    }, before);
    map.addLayer({
        id: "picking-route-line", type: "line", source: PICKING_ROUTE_SOURCE,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": ["get", "color"], "line-width": ["case", selected, 5, 3], "line-opacity": ["case", selected, 1, 0.6] },
    }, before);
    map.addLayer({
        id: "picking-route-arrows", type: "symbol", source: PICKING_ROUTE_SOURCE, filter: selected,
        layout: {
            "symbol-placement": "line", "symbol-spacing": 70, "icon-image": "picking-arrow", "icon-size": 0.9,
            "icon-allow-overlap": true, "icon-ignore-placement": true, "icon-rotation-alignment": "map",
        },
    }, before);
    for (const id of PICKING_LAYERS) map.setLayerZoomRange(id, ZOOM.STORE_OVERLAYS, 24);
    picking.layersReady = true;
}

function clearPickingMarkers() {
    picking.markers.forEach((marker) => marker.remove());
    picking.markers = [];
}

function stopPopup(stop, number, plan, cart) {
    const lines = stop.lines.map((entry) => h("li", { className: entry.picked ? "done" : "" },
        h("strong", {}, entry.line.product_name), ` × ${entry.line.quantity}`,
        h("span", {}, ` · ${entry.order_id} · ${entry.picked ? "Picked" : "To pick"}`)));
    return h("div", { className: "picking-popup" },
        h("div", { className: "picking-popup-title" }, number ? `Stop ${number}` : "Completed stop", ` · ${cart.name}`),
        h("div", {}, h("strong", {}, stop.rack_id), ` · ${rackPlace(inventory.model?.get(stop.rack_id) || stop)}`),
        h("ul", {}, lines));
}

function addMarker(lngLat, className, text, popupContent, title) {
    const element = h("div", { className: `picking-marker ${className}`, title }, text);
    const marker = new maplibregl.Marker({ element, anchor: "center" }).setLngLat(lngLat);
    if (popupContent) marker.setPopup(new maplibregl.Popup({ offset: 14 }).setDOMContent(popupContent));
    marker.addTo(state.map);
    picking.markers.push(marker);
    return marker;
}

function renderPickingMap() {
    drawPickingMap();
    // Route stops are placed first; map labels under them step aside.
    if (typeof declutterLabels === "function") declutterLabels();
}

function drawPickingMap() {
    if (!picking.layersReady) return;
    clearPickingMarkers();
    const routes = state.map.getSource(PICKING_ROUTE_SOURCE);
    const target = state.map.getSource(PICKING_TARGET_SOURCE);
    const visible = picking.tab === "picking" && picking.store && picking.network && picking.toMap;
    for (const id of PICKING_LAYERS) state.map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    if (!visible) {
        routes?.setData(emptyCollection());
        target?.setData(emptyCollection());
        return;
    }
    const { settings } = picking.store;
    const features = [];
    for (const cart of picking.store.carts) {
        const isSelected = cart.cart_id === settings.selectedCart;
        if (!isSelected && !settings.showAllRoutes) continue;
        const plan = planFor(cart.cart_id);
        if (!plan) continue;
        for (const coordinates of plan.coords) {
            features.push({ type: "Feature", properties: { cart_id: cart.cart_id, color: cart.color, selected: isSelected }, geometry: { type: "LineString", coordinates } });
        }
    }
    // Selected route on top.
    features.sort((a, b) => a.properties.selected - b.properties.selected);
    routes.setData({ type: "FeatureCollection", features });

    const cart = picking.store.cart(settings.selectedCart);
    const plan = cart && planFor(cart.cart_id);
    // Highlight every rack each shown cart has to visit (and has visited).
    const racks = [];
    for (const shown of picking.store.carts) {
        if (shown.cart_id !== settings.selectedCart && !settings.showAllRoutes) continue;
        const shownPlan = planFor(shown.cart_id);
        if (!shownPlan) continue;
        const next = shownPlan.order[0];
        for (const stop of shownPlan.stops) {
            const link = inventory.racks.get(stop.rack_id);
            if (!link) continue;
            const stage = stop.done ? "done" : stop.rack_id === next && shown.cart_id === settings.selectedCart ? "next" : "pending";
            racks.push({ type: "Feature", properties: { color: shown.color, stage, rack_id: stop.rack_id, cart_id: shown.cart_id }, geometry: link.geometry });
        }
    }
    // Next stop drawn last so it sits on top.
    racks.sort((a, b) => (a.properties.stage === "next") - (b.properties.stage === "next"));
    target.setData({ type: "FeatureCollection", features: racks });
    if (!cart || !plan || !cart.orders.length) return;

    const network = picking.network;
    const toMap = (cell) => picking.toMap(network.cellToSource(cell));
    const tint = (marker) => marker.getElement().style.setProperty("--cart", cart.color);
    const stopsById = new Map(plan.stops.map((stop) => [stop.rack_id, stop]));
    for (const stop of plan.stops.filter((s) => s.done)) {
        const cell = network.rackAccess[stop.rack_id];
        if (cell != null) tint(addMarker(toMap(cell), "done", "✓", stopPopup(stop, null, plan, cart), `${stop.rack_id} completed`));
    }
    plan.order.forEach((rackId, i) => {
        const stop = stopsById.get(rackId);
        const marker = addMarker(toMap(network.rackAccess[rackId]), i === 0 ? "current" : "pending", String(i + 1), stopPopup(stop, i + 1, plan, cart), `Stop ${i + 1}: ${rackId}`);
        tint(marker);
        marker.getElement().dataset.rackId = rackId;
    });
    if (plan.start != null && cart.location == null) {
        tint(addMarker(toMap(plan.start), "start", "S", h("div", {}, h("strong", {}, `${cart.name} start`), h("div", {}, plan.startLabel)), "Cart start"));
    }
    if (dispatchCell() != null) {
        tint(addMarker(toMap(dispatchCell()), "end", "D", h("div", {}, h("strong", {}, network.dispatch.name),
            h("div", {}, "Picked orders are packed here and handed to the delivery driver.")), network.dispatch.name));
    }
}

/* ---------------------------------------------------------------------- */
/* Store lifecycle hooks                                                   */
/* ---------------------------------------------------------------------- */

function subscribePickingInventory() {
    const model = inventory.model;
    if (picking.subscribedModel === model) return;
    picking.unsubscribe?.();
    picking.unsubscribe = null;
    picking.subscribedModel = model;
    if (!model?.subscribe) return;
    picking.unsubscribe = model.subscribe((event) => {
        if (event.type === "reset") picking.store?.inventoryReset(event.rackId);
        if (picking.tab === "picking") renderPickingPanel();
    });
}

async function onPickingInventoryReady(store, alignedData, sourceData) {
    ensurePickingLayers();
    picking.toMap = makePickingAligner(store, sourceData);
    picking.alignVersion += 1;
    if (picking.storeId !== store.store_id) {
        const generation = ++picking.generation;
        Object.assign(picking, { storeId: store.store_id, store: null, network: null, loading: true, error: "", detailsOrderId: null });
        picking.selectedOrders.clear();
        picking.plans.clear();
        picking.newOrders.clear();
        stopOrderFeedTimer();
        renderPickingPanel();
        try {
            const [orders, network] = await Promise.all([OrderManagement.load(store.store_id), IndoorRouting.load(store.store_id)]);
            if (generation !== picking.generation) return;
            Object.assign(picking, { store: orders, network });
        } catch (error) {
            console.error(`Order picking ${store.store_id}:`, error);
            if (generation === picking.generation) picking.error = "Online orders could not be loaded for this store.";
        }
        if (generation !== picking.generation) return;
        picking.loading = false;
        subscribePickingInventory();
        // Testing aid, off the staff screen: ?reset=1 restores the starting orders once per page load.
        if (picking.store && new URLSearchParams(window.location.search).has("reset") && !picking.resetDone.has(store.store_id)) {
            picking.resetDone.add(store.store_id);
            resetPickingData();
        }
        scheduleOrderFeed();
    }
    subscribePickingInventory();
    refreshPicking();
}

function clearPickingLayers() {
    if (!picking.layersReady) return;
    clearPickingMarkers();
    state.map.getSource(PICKING_ROUTE_SOURCE)?.setData(emptyCollection());
    state.map.getSource(PICKING_TARGET_SOURCE)?.setData(emptyCollection());
    if (picking.storeId && picking.storeId !== state.currentStoreId) {
        ++picking.generation;
        stopOrderFeedTimer();
        Object.assign(picking, { storeId: null, store: null, network: null, loading: false, error: "", detailsOrderId: null });
        picking.selectedOrders.clear();
        picking.plans.clear();
        picking.newOrders.clear();
        renderPickingPanel();
    }
}

function refreshPicking() {
    renderPickingMap();
    renderPickingPanel();
}

/* ---------------------------------------------------------------------- */
/* Actions                                                                 */
/* ---------------------------------------------------------------------- */

function setPickingMessage(result) {
    picking.message = { text: result?.message || "", error: result ? !result.ok : false };
}

/* Incoming online orders ------------------------------------------------ */

function stopOrderFeedTimer() {
    window.clearTimeout(picking.feedTimer);
    picking.feedTimer = null;
}

function scheduleOrderFeed() {
    stopOrderFeedTimer();
    if (!picking.store || picking.feedStopped) return;
    const [low, high] = ORDER_FEED_MINUTES;
    picking.feedTimer = window.setTimeout(receiveOnlineOrder, (low + Math.random() * (high - low)) * 60000);
}

// A new order from the web shop lands in the queue as Pending.
function receiveOnlineOrder() {
    if (!picking.store) return null;
    const result = picking.store.generateOrder();
    if (result.ok) {
        const id = result.order.order_id;
        picking.newOrders.add(id);
        window.setTimeout(() => { if (picking.newOrders.delete(id)) renderOrderQueue(); }, NEW_ORDER_HIGHLIGHT_MS);
        setPickingMessage({ ok: true, message: `New online order ${id} received · ${result.order.lines.length} items.` });
        refreshPicking();
    }
    scheduleOrderFeed();
    return result.ok ? result.order.order_id : null;
}

// Starting orders back and picked stock returned (testing aid; see ?reset=1).
function resetPickingData() {
    if (!picking.store) return;
    picking.selectedOrders.clear();
    picking.detailsOrderId = null;
    picking.plans.clear();
    picking.newOrders.clear();
    afterStockChange(picking.store.reset(inventory.model));
}

function afterStockChange(result) {
    setPickingMessage(result);
    if (result.ok && typeof refreshAfterEdit === "function") refreshAfterEdit();  // inventory panel + rack colours
    refreshPicking();
}

function selectedCart() {
    return picking.store?.cart(picking.store.settings.selectedCart) || null;
}

function selectCart(cartId) {
    picking.store.settings.selectedCart = cartId;
    picking.store.save();
    refreshPicking();
}

function pickLine(orderId, lineNo) {
    afterStockChange(picking.store.pickLine(orderId, lineNo, inventory.model));
}

function undoLine(orderId, lineNo) {
    afterStockChange(picking.store.undoLine(orderId, lineNo, inventory.model));
}

// "Mark Item Picked": the next unpicked line at the next stop on the route.
function pickNextItem() {
    const cart = selectedCart();
    const plan = cart && planFor(cart.cart_id);
    const stop = plan?.stops.find((s) => s.rack_id === plan.order[0]);
    const entry = stop?.lines.find((item) => !item.picked);
    if (!entry) {
        setPickingMessage({ ok: false, message: cart?.orders.length ? "Nothing left to pick on the route; pack the orders at Pack & Dispatch." : "This cart has no orders." });
        refreshPicking();
        return;
    }
    pickLine(entry.order_id, entry.line.line_no);
}

function completeOrder(orderId) {
    setPickingMessage(picking.store.complete(orderId));
    refreshPicking();
}

function handToDriver(orderId = null) {
    setPickingMessage(picking.store.handToDriver(orderId));
    refreshPicking();
}

/* ---------------------------------------------------------------------- */
/* Sidebar: Order Picking tab                                              */
/* ---------------------------------------------------------------------- */

function statusBadge(status) {
    return h("span", { className: `picking-status status-${status.toLowerCase()}` }, status);
}

function priorityBadge(priority) {
    return h("span", { className: `picking-priority priority-${priority.toLowerCase()}` }, priority);
}

function cartDot(cart) {
    return h("span", { className: "picking-cart-dot", style: { background: cart.color } });
}

function miniProgress(percent, color) {
    return h("div", { className: "inventory-progress compact picking-progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(percent) },
        h("span", { style: { width: `${percent}%`, background: color || "var(--inv-blue)" } }));
}

function formatDuration(seconds) {
    if (!Number.isFinite(seconds)) return "—";
    const minutes = Math.floor(seconds / 60), rest = Math.round(seconds % 60);
    return minutes ? `${minutes} min ${rest} s` : `${rest} s`;
}

function renderPickingPanel() {
    const ready = Boolean(picking.store && picking.network);
    pk$("picking-content").hidden = !ready;
    const message = pk$("picking-message");
    const status = picking.loading ? "Loading online orders…"
        : picking.error ? picking.error
        : !picking.storeId ? "Select a store with an indoor map to pick online orders."
        : !ready ? "No online order data for this store."
        : picking.message.text;
    message.textContent = status;
    message.hidden = !status;
    message.classList.toggle("warning", Boolean(picking.error) || (ready && picking.message.error));
    if (!ready) return;
    pk$("picking-storage-note").hidden = picking.store.storageAvailable;
    renderPickingStats();
    renderCartCards();
    renderCartDetail();
    renderOrderQueue();
    renderOrderDetails();
}

function renderPickingStats() {
    const stats = picking.store.stats();
    const tile = (label, value, kind = "") => h("div", { className: `inventory-stat ${kind}` },
        h("span", { className: "inventory-stat-value" }, String(value)), h("span", { className: "inventory-stat-label" }, label));
    pk$("picking-stats").replaceChildren(
        tile("Total orders", stats.total),
        tile("Pending", stats.pending, "status-pending"),
        tile("In progress", stats.inProgress, "status-picking"),
        tile("Packed", stats.packed, "status-packed"),
        tile("Handed to driver", stats.dispatched, "status-dispatched"),
        tile("Active carts", `${stats.activeCarts} / ${picking.store.carts.length}`),
    );
    const waiting = pk$("picking-dispatch-all");
    waiting.disabled = !stats.packed;
    waiting.textContent = stats.packed ? `Hand ${stats.packed} Packed to Driver` : "Hand Packed to Driver";
    pk$("picking-show-all").checked = Boolean(picking.store.settings.showAllRoutes);
}

function renderCartCards() {
    const selected = picking.store.settings.selectedCart;
    pk$("picking-carts").replaceChildren(...picking.store.carts.map((cart) => {
        const summary = picking.store.cartSummary(cart);
        return h("button", {
            type: "button", className: `picking-cart-card${cart.cart_id === selected ? " selected" : ""}`,
            style: { "--cart": cart.color }, dataset: { cartId: cart.cart_id }, "aria-pressed": String(cart.cart_id === selected),
            onClick: () => selectCart(cart.cart_id),
        },
        h("span", { className: "picking-cart-name" }, cartDot(cart), cart.name),
        h("span", { className: "picking-cart-picker" }, cart.picker),
        h("span", { className: "picking-cart-meta" }, `${summary.orders.length} order${summary.orders.length === 1 ? "" : "s"} · ${summary.picked}/${summary.total} items`),
        miniProgress(summary.percent, cart.color),
        statusBadge(summary.status));
    }));
}

function renderCartDetail() {
    const panel = pk$("picking-cart-detail");
    const cart = selectedCart();
    if (!cart) { panel.replaceChildren(); return; }
    const summary = picking.store.cartSummary(cart);
    const plan = planFor(cart.cart_id);
    const speed = Number(picking.store.settings.walkSpeed) || 1;
    const remainingStops = plan?.order.length || 0;
    const remainingItems = summary.total - summary.picked;
    const methodText = !plan || !cart.orders.length ? "" :
        plan.method === "exact" ? `Stop order: exact - shortest of all ${remainingStops}-stop sequences on the walking network.` :
        plan.method === "heuristic" ? "Stop order: optimised with nearest-neighbour + 2-opt (practical, not guaranteed shortest)." :
        plan.method === "direct" ? "Single stop - direct walking path." : "";

    const speedInput = h("input", {
        id: "picking-speed", type: "number", min: "0.3", max: "2.5", step: "0.1", value: String(speed), "aria-label": "Walking speed in metres per second",
        onChange: (event) => {
            const value = Number(event.target.value);
            if (Number.isFinite(value) && value >= 0.3 && value <= 2.5) { picking.store.settings.walkSpeed = value; picking.store.save(); }
            renderCartDetail();
        },
    });
    const stopsById = new Map((plan?.stops || []).map((stop) => [stop.rack_id, stop]));
    const ordered = (plan?.order || []).map((id) => stopsById.get(id));
    const flagged = (plan?.unreachable || []).map((id) => stopsById.get(id)).filter(Boolean);
    const done = (plan?.stops || []).filter((stop) => stop.done);

    setChildren(panel,
        h("div", { className: "picking-cart-head", style: { "--cart": cart.color } },
            h("div", {}, h("h3", {}, cartDot(cart), cart.name), h("div", { className: "picking-cart-picker" }, `Picker: ${cart.picker}`)),
            statusBadge(summary.status)),
        cart.orders.length ? h("div", { className: "picking-route-summary" },
            h("div", { className: "picking-route-grid" },
                h("div", {}, h("span", {}, "Remaining route"), h("strong", { id: "picking-route-distance" }, `${Math.round(plan?.distance || 0)} m`)),
                h("div", {}, h("span", {}, "Est. walking time"), h("strong", {}, formatDuration((plan?.distance || 0) / speed))),
                h("div", {}, h("span", {}, "Stops left"), h("strong", {}, String(remainingStops))),
                h("div", {}, h("span", {}, "Items left"), h("strong", {}, String(remainingItems)))),
            h("label", { className: "picking-speed" }, "Walking speed ", speedInput, " m/s (with cart)"),
            methodText ? h("p", { className: "picking-method" }, methodText) : null,
            h("p", { className: "picking-location" }, h("strong", {}, "Current location: "), plan?.startLabel || "—"),
            ...(plan?.warnings || []).map((text) => h("p", { className: "picking-warning" }, text)))
            : h("p", { className: "picking-empty" }, "No orders on this cart. Select orders in the queue below and assign them here."),
        h("div", { className: "picking-actions" },
            h("button", { type: "button", id: "picking-start", disabled: !cart.orders.length || cart.started, onClick: () => { setPickingMessage(picking.store.startPicking(cart.cart_id)); refreshPicking(); } }, cart.started ? "Picking started" : "Start Picking"),
            h("button", { type: "button", id: "picking-pick-next", className: "primary", disabled: !remainingStops, onClick: pickNextItem }, "Mark Item Picked")),
        cart.orders.length ? h("div", { className: "picking-cart-orders" },
            h("h4", {}, "Orders on this cart"),
            ...summary.orders.map((order) => {
                const progress = picking.store.progress(order);
                const orderStatus = picking.store.status(order);
                return h("div", { className: "picking-cart-order", dataset: { orderId: order.order_id } },
                    h("div", { className: "picking-cart-order-head" },
                        h("button", { type: "button", className: "inventory-link-button", onClick: () => { picking.detailsOrderId = order.order_id; renderOrderDetails(true); } }, order.order_id),
                        priorityBadge(order.priority), statusBadge(orderStatus),
                        h("span", { className: "picking-muted" }, `${progress.picked}/${progress.total} items`)),
                    miniProgress(progress.percent, cart.color),
                    h("div", { className: "picking-row-actions" },
                        h("button", { type: "button", className: "picking-complete", disabled: orderStatus !== "Picked", onClick: () => completeOrder(order.order_id) }, "Mark Packed"),
                        h("button", { type: "button", disabled: progress.pickedLines > 0, onClick: () => { setPickingMessage(picking.store.unassign(order.order_id)); refreshPicking(); } }, "Remove")));
            })) : null,
        cart.orders.length ? h("div", { className: "picking-checklist" },
            h("h4", {}, "Picking checklist"),
            ...ordered.map((stop, i) => checklistStop(stop, i === 0 ? "next" : "pending", i + 1, cart)),
            ...flagged.map((stop) => checklistStop(stop, "flagged", null, cart)),
            done.length ? h("div", { className: "picking-done-head" }, `Completed stops (${done.length})`) : null,
            ...done.map((stop) => checklistStop(stop, "done", null, cart)),
            dispatchCell() != null ? h("div", { className: "picking-stop dropoff" }, h("div", { className: "picking-stop-head" },
                h("span", { className: "picking-stop-number end" }, "D"), h("strong", {}, `Drop off at ${picking.network.dispatch.name}`))) : null)
            : null,
    );
}

function checklistStop(stop, kind, number, cart) {
    const label = kind === "next" ? "Next stop" : kind === "flagged" ? "Needs review" : kind === "done" ? "Done" : "";
    return h("div", { className: `picking-stop ${kind}`, style: { "--cart": cart.color }, dataset: { rackId: stop.rack_id } },
        h("div", { className: "picking-stop-head" },
            h("span", { className: "picking-stop-number" }, kind === "done" ? "✓" : kind === "flagged" ? "!" : String(number)),
            h("strong", {}, stop.rack_id), h("span", { className: "picking-muted" }, ` · ${rackPlace(inventory.model?.get(stop.rack_id) || stop)}`),
            label ? h("span", { className: `picking-stop-tag ${kind}` }, label) : null),
        ...stop.lines.map((entry) => checklistLine(entry, kind)));
}

function checklistLine(entry, kind) {
    const { line, order_id: orderId, picked } = entry;
    const stock = picking.store.available(inventory.model, line);
    const short = !picked && (stock == null || stock < line.quantity);
    return h("div", { className: `picking-line${picked ? " picked" : ""}`, dataset: { lineKey: entry.key } },
        h("div", { className: "picking-line-main" },
            h("div", { className: "picking-line-name" }, line.product_name),
            h("div", { className: "picking-muted" }, `${line.sku} · Qty ${line.quantity} · ${orderId}`),
            short ? h("span", { className: "picking-short" }, stock == null ? "Not stocked here" : `Insufficient Stock (${stock} on shelf)`)
                : !picked ? h("span", { className: "picking-muted" }, `${stock} on shelf`) : null),
        picked
            ? h("div", { className: "picking-line-actions" }, h("span", { className: "picking-picked" }, "✓ Picked"),
                h("button", { type: "button", className: "picking-undo", disabled: picking.store.isCompleted(orderId), onClick: () => undoLine(orderId, line.line_no) }, "Undo"))
            : h("button", { type: "button", className: "picking-pick", disabled: short || kind === "flagged", onClick: () => pickLine(orderId, line.line_no) }, "Mark as Picked"));
}

function renderOrderQueue() {
    const store = picking.store;
    const orders = store.search(picking.filters.query, picking.filters);
    pk$("picking-order-count").textContent = `${orders.length} of ${store.orders.length} orders`;
    for (const id of [...picking.selectedOrders]) if (!store.order(id) || store.isCompleted(id)) picking.selectedOrders.delete(id);
    pk$("picking-selected-count").textContent = `${picking.selectedOrders.size} selected`;
    const assignSelect = pk$("picking-assign-cart");
    const current = assignSelect.value || store.settings.selectedCart;
    assignSelect.replaceChildren(...store.carts.map((cart) => new Option(`${cart.name} · ${cart.picker}`, cart.cart_id)));
    assignSelect.value = current;
    pk$("picking-assign").disabled = !picking.selectedOrders.size;
    const selectable = orders.filter((order) => !store.isCompleted(order.order_id));
    const all = pk$("picking-select-all");
    all.checked = selectable.length > 0 && selectable.every((order) => picking.selectedOrders.has(order.order_id));
    all.disabled = !selectable.length;
    const body = pk$("picking-order-body");
    if (!orders.length) {
        body.replaceChildren(h("tr", {}, h("td", { colspan: "7", className: "empty" }, "No orders match the current filters")));
        return;
    }
    body.replaceChildren(...orders.map((order) => {
        const status = store.status(order);
        const cart = store.cartOf(order.order_id);
        const progress = store.progress(order);
        const completed = store.isCompleted(order.order_id);
        const isNew = picking.newOrders.has(order.order_id);
        return h("tr", { className: [picking.detailsOrderId === order.order_id ? "selected" : "", isNew ? "is-new" : ""].join(" ").trim(), dataset: { orderId: order.order_id } },
            h("td", { className: "picking-check" }, h("input", {
                type: "checkbox", "aria-label": `Select ${order.order_id}`, disabled: completed,
                ...(picking.selectedOrders.has(order.order_id) ? { checked: true } : {}),
                onChange: (event) => { event.target.checked ? picking.selectedOrders.add(order.order_id) : picking.selectedOrders.delete(order.order_id); renderOrderQueue(); },
            })),
            h("td", { className: "rack", title: isNew ? "New online order" : null }, order.order_id),
            h("td", { title: `${progress.total} units` }, `${order.lines.length}`),
            h("td", {}, priorityBadge(order.priority)),
            h("td", {}, cart ? h("span", { className: "picking-cart-label" }, cartDot(cart), cart.name.replace("Cart ", "C")) : "—"),
            h("td", {}, statusBadge(status)),
            h("td", {}, status === "Packed"
                ? h("button", { type: "button", className: "picking-handover", onClick: () => handToDriver(order.order_id) }, "Hand to Driver")
                : h("button", { type: "button", className: "inventory-link-button", onClick: () => { picking.detailsOrderId = order.order_id; renderOrderQueue(); renderOrderDetails(true); } }, "Details")));
    }));
}

function renderOrderDetails(scroll = false) {
    const panel = pk$("picking-order-details");
    const order = picking.detailsOrderId ? picking.store.order(picking.detailsOrderId) : null;
    panel.hidden = !order;
    if (!order) { panel.replaceChildren(); return; }
    const store = picking.store;
    const status = store.status(order);
    const cart = store.cartOf(order.order_id);
    const progress = store.progress(order);
    setChildren(panel,
        h("div", { className: "inventory-details-header" },
            h("div", {}, h("div", { className: "inventory-details-kicker" }, "Online order"), h("h3", { id: "picking-details-title" }, order.order_id)),
            h("div", { className: "inventory-details-chips" }, priorityBadge(order.priority), statusBadge(status)),
            h("button", { type: "button", className: "inventory-icon-button", "aria-label": "Close order details", onClick: () => { picking.detailsOrderId = null; renderOrderQueue(); renderOrderDetails(); } }, "×")),
        h("dl", { className: "inventory-fields" },
            h("div", { className: "inventory-field" }, h("dt", {}, "Customer"), h("dd", {}, order.customer_ref)),
            h("div", { className: "inventory-field" }, h("dt", {}, "Ordered"), h("dd", {}, formatTime(order.order_time))),
            h("div", { className: "inventory-field" }, h("dt", {}, "Cart"), h("dd", {}, cart ? `${cart.name} · ${cart.picker}` : "Not assigned")),
            h("div", { className: "inventory-field" }, h("dt", {}, "Progress"), h("dd", {}, `${progress.percent}% (${progress.picked}/${progress.total} items)`))),
        miniProgress(progress.percent, cart?.color),
        h("table", { className: "inventory-products" },
            h("thead", {}, h("tr", {}, h("th", {}, "Product"), h("th", {}, "Rack"), h("th", {}, "Aisle"), h("th", { className: "num" }, "Qty"), h("th", {}, "Status"))),
            h("tbody", {}, order.lines.map((line) => {
                const pick = store.pick(order.order_id, line.line_no);
                return h("tr", {},
                    h("td", {}, line.product_name, h("div", { className: "sku" }, line.sku)),
                    h("td", {}, line.rack_id), h("td", {}, aisleCell(inventory.model?.get(line.rack_id) || line)),
                    h("td", { className: "num" }, String(line.quantity)),
                    h("td", {}, pick ? "Picked" : "To pick"));
            }))),
        h("div", { className: "picking-row-actions" },
            status === "Packed" || status === "Dispatched"
                ? h("button", { type: "button", className: "picking-handover", disabled: status === "Dispatched", onClick: () => handToDriver(order.order_id) }, status === "Dispatched" ? "Handed to driver" : "Hand to Driver")
                : h("button", { type: "button", className: "picking-complete", disabled: status !== "Picked", onClick: () => completeOrder(order.order_id) }, "Mark Packed"),
            cart && !progress.pickedLines ? h("button", { type: "button", onClick: () => { setPickingMessage(store.unassign(order.order_id)); refreshPicking(); } }, `Remove from ${cart.name}`) : null),
    );
    if (scroll) panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

/* ---------------------------------------------------------------------- */
/* Tabs and wiring                                                         */
/* ---------------------------------------------------------------------- */

function setOpsTab(tab) {
    picking.tab = tab === "picking" ? "picking" : "inventory";
    const isPicking = picking.tab === "picking";
    pk$("ops-tab-inventory").setAttribute("aria-selected", String(!isPicking));
    pk$("ops-tab-picking").setAttribute("aria-selected", String(isPicking));
    pk$("inventory-tab").hidden = isPicking;
    pk$("picking-tab").hidden = !isPicking;
    pk$("inventory-title").textContent = isPicking ? "Online Order Picking" : "Inventory Management";
    try { sessionStorage.setItem("ops-panel:tab", picking.tab); } catch (error) { /* per-tab preference only */ }
    refreshPicking();
}

function wirePickingPanel() {
    pk$("ops-tab-inventory").addEventListener("click", () => setOpsTab("inventory"));
    pk$("ops-tab-picking").addEventListener("click", () => setOpsTab("picking"));
    for (const tab of document.querySelectorAll(".ops-tabs [role=tab]")) {
        tab.addEventListener("keydown", (event) => {
            if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                setOpsTab(picking.tab === "picking" ? "inventory" : "picking");
                pk$(picking.tab === "picking" ? "ops-tab-picking" : "ops-tab-inventory").focus();
            }
        });
    }

    pk$("picking-dispatch-all").addEventListener("click", () => { if (picking.store) handToDriver(); });
    pk$("picking-show-all").addEventListener("change", (event) => {
        if (!picking.store) return;
        picking.store.settings.showAllRoutes = event.target.checked;
        picking.store.save();
        renderPickingMap();
    });
    pk$("picking-search").addEventListener("input", (event) => { picking.filters.query = event.target.value; renderOrderQueue(); });
    pk$("picking-filter-status").addEventListener("change", (event) => { picking.filters.status = event.target.value; renderOrderQueue(); });
    pk$("picking-filter-priority").addEventListener("change", (event) => { picking.filters.priority = event.target.value; renderOrderQueue(); });
    pk$("picking-select-all").addEventListener("change", (event) => {
        const orders = picking.store?.search(picking.filters.query, picking.filters) || [];
        for (const order of orders) {
            if (picking.store.isCompleted(order.order_id)) continue;
            event.target.checked ? picking.selectedOrders.add(order.order_id) : picking.selectedOrders.delete(order.order_id);
        }
        renderOrderQueue();
    });
    pk$("picking-assign").addEventListener("click", () => {
        if (!picking.store || !picking.selectedOrders.size) return;
        const cartId = pk$("picking-assign-cart").value;
        const result = picking.store.assign([...picking.selectedOrders], cartId);
        setPickingMessage(result);
        if (result.ok) {
            picking.selectedOrders.clear();
            picking.store.settings.selectedCart = cartId;
            picking.store.save();
        }
        refreshPicking();
    });

    let tab = "inventory";
    try { tab = sessionStorage.getItem("ops-panel:tab") || tab; } catch (error) { /* default */ }
    setOpsTab(tab);
}

document.addEventListener("DOMContentLoaded", wirePickingPanel);
